#!/usr/bin/env python3
"""
Génère un QR code PNG à partir d'un texte, via le générateur pur Python déjà
embarqué dans reportlab (aucune dépendance réseau nécessaire).

Usage: qr_helper.py <texte> <chemin_sortie.png> [échelle_px_par_module]
"""
import sys
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.barcode import qrencoder
from PIL import Image, ImageDraw


def generate(text, out_path, scale=10, quiet=4):
    widget = QrCodeWidget(text, barLevel='Q')  # niveau Q : reste lisible même si le
                                                # QR est partiellement recouvert/froissé (badge physique)
    qr = widget.qr
    qr.make()
    n = qr.getModuleCount()
    size = (n + 2 * quiet) * scale

    img = Image.new('RGB', (size, size), 'white')
    draw = ImageDraw.Draw(img)
    for r in range(n):
        for c in range(n):
            if qr.isDark(r, c):
                x0 = (c + quiet) * scale
                y0 = (r + quiet) * scale
                draw.rectangle([x0, y0, x0 + scale - 1, y0 + scale - 1], fill='black')
    img.save(out_path)


if __name__ == '__main__':
    text = sys.argv[1]
    out_path = sys.argv[2]
    scale = int(sys.argv[3]) if len(sys.argv) > 3 else 10
    generate(text, out_path, scale=scale)
