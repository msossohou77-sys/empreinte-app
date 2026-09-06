#!/usr/bin/env python3
"""
Helper DOCX pour Empreinte.
- extract-fields <template.docx>      -> imprime en JSON la liste des champs {{champ}} détectés
- render <template.docx> <values.json> <out.docx> -> remplace les champs et enregistre le résultat

On reste volontairement en dehors de docxtemplater (indisponible hors-ligne) : python-docx
suffit pour ce besoin (remplacement de texte), et est déjà présent dans l'environnement.
"""
import sys
import json
import re
from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph

PATTERN = re.compile(r'\{\{\s*([^{}]+?)\s*\}\}')


def iter_all_paragraphs(doc):
    """Parcourt TOUS les paragraphes du document, à n'importe quelle profondeur :
    corps principal, tableaux (imbriqués ou non), zones de texte / formes, ET
    en-têtes / pieds de page. On descend directement dans l'arbre XML (w:p =
    paragraphe, peu importe où il se trouve) plutôt que de se limiter à l'API
    de haut niveau de python-docx (doc.paragraphs / doc.tables), qui ne voit pas
    le contenu des zones de texte. C'est ce qui permet de conserver la mise en
    forme d'origine (polices, styles, formes) même quand un champ {{...}} est
    placé dans un en-tête ou une zone de texte, pas seulement dans le corps.
    """
    for p_element in doc.element.body.iter(qn('w:p')):
        yield Paragraph(p_element, doc)

    for section in doc.sections:
        candidates = [section.header, section.footer]
        try:
            if section.different_first_page_header_footer:
                candidates += [section.first_page_header, section.first_page_footer]
        except Exception:
            pass
        for part in candidates:
            if part is None:
                continue
            try:
                for p_element in part._element.iter(qn('w:p')):
                    yield Paragraph(p_element, part)
            except Exception:
                continue


def extract_fields(path):
    doc = Document(path)
    seen = []
    for p in iter_all_paragraphs(doc):
        for m in PATTERN.finditer(p.text):
            name = m.group(1).strip()
            if name not in seen:
                seen.append(name)
    print(json.dumps(seen))


def replace_in_paragraph(paragraph, mapping):
    full_text = paragraph.text
    if not PATTERN.search(full_text):
        return

    def sub(m):
        key = m.group(1).strip()
        return str(mapping.get(key, ''))

    # Cas courant : le champ {{xxx}} est entièrement contenu dans un seul run.
    # On ne remplace alors que ce run, ce qui préserve la mise en forme des autres
    # (gras, italique...) au lieu de tout écraser dans le premier run du paragraphe.
    for run in paragraph.runs:
        if PATTERN.search(run.text):
            run.text = PATTERN.sub(sub, run.text)

    # Cas plus rare : un champ est coupé entre plusieurs runs (ex. Word a scindé le
    # texte lors de la frappe). On retombe alors sur un remplacement global du
    # paragraphe, au prix de la mise en forme fine de ce paragraphe uniquement.
    if PATTERN.search(paragraph.text) and paragraph.runs:
        new_text = PATTERN.sub(sub, paragraph.text)
        paragraph.runs[0].text = new_text
        for r in paragraph.runs[1:]:
            r.text = ''


def render(template_path, values_json_path, out_path):
    with open(values_json_path, 'r', encoding='utf-8') as f:
        mapping = json.load(f)
    doc = Document(template_path)
    for p in iter_all_paragraphs(doc):
        replace_in_paragraph(p, mapping)
    doc.save(out_path)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'extract-fields':
        extract_fields(sys.argv[2])
    elif cmd == 'render':
        render(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        print(json.dumps({'error': 'commande inconnue'}))
        sys.exit(1)
