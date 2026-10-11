"""Draws the headline and caption layers with Pillow for the exported video."""
from functools import lru_cache

from PIL import Image, ImageDraw, ImageFont

from .. import config
from .timeline import ease, parse_headline, wrap_words

FONTS = {
    "Anton": "Anton.ttf",
    "Bebas Neue": "BebasNeue.ttf",
    "Oswald": "Oswald-Bold.ttf",
    "Montserrat": "Montserrat-ExtraBold.ttf",
    "Poppins": "Poppins-Bold.ttf",
    "Playfair": "PlayfairDisplay-BoldItalic.ttf",
    "Lobster": "Lobster-Regular.ttf",
}

W, H = config.OUT_W, config.OUT_H


def user_fonts() -> list[dict]:
    """Brand fonts the user uploaded: [{id, name, file}]."""
    import json
    f = config.USER_FONTS_DIR / "fonts.json"
    return json.loads(f.read_text()) if f.exists() else []


def _font_path(name: str):
    if name in FONTS:
        return config.FONTS_DIR / FONTS[name]
    for uf in user_fonts():
        if uf["name"] == name and (config.USER_FONTS_DIR / uf["file"]).exists():
            return config.USER_FONTS_DIR / uf["file"]
    return config.FONTS_DIR / FONTS["Montserrat"]


@lru_cache(maxsize=64)
def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_font_path(name)), max(8, size))


def _measure(f, words):
    return f.getlength(" ".join(w[0] for w in words))


def _draw_lines(draw, lines, f, cx, cy, line_h, colors, stroke=0, stroke_color="#000000", box=None):
    """lines: list of list[(word, color_key)]. Returns bbox (x0, y0, x1, y1).
    box: optional fill colour drawn as a rounded rectangle behind words whose key is True."""
    n = len(lines)
    space = f.getlength(" ")
    x0s, x1s = [], []
    for i, ln in enumerate(lines):
        y = cy - (n - 1) * line_h / 2 + i * line_h
        total = _measure(f, ln)
        x = cx - total / 2
        x0s.append(x)
        x1s.append(x + total)
        for word, key in ln:
            wl = f.getlength(word)
            if box and key:
                size = f.size
                draw.rounded_rectangle((x - size * 0.18, y - size * 0.62, x + wl + size * 0.18, y + size * 0.62),
                                       radius=int(size * 0.22), fill=box)
            draw.text((x, y), word, font=f, fill=colors[key], anchor="lm",
                      stroke_width=0 if (box and key) else stroke, stroke_fill=stroke_color)
            x += wl + space
    return (min(x0s, default=cx), cy - n * line_h / 2, max(x1s, default=cx), cy + n * line_h / 2)


def headline_layer(h: dict) -> Image.Image | None:
    """Full-frame transparent image with the static headline."""
    if not h.get("enabled") or not h.get("text", "").strip():
        return None
    text = h["text"].upper() if h.get("uppercase", True) else h["text"]
    size = int(h.get("size", 150))
    f = font(h.get("font", "Anton"), size)
    lines = []
    for ln in parse_headline(text):
        lines += wrap_words(ln, lambda ws: _measure(f, ws), W * h.get("maxWidth", 0.92))
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    colors = {False: h.get("color", "#E9E1D3"), True: h.get("accent", "#D7262E")}
    cx, cy, lh = h.get("x", 0.5) * W, h.get("y", 0.25) * H, h.get("lineHeight", 0.95)
    draw = ImageDraw.Draw(img)
    if h.get("block", True) and lines:
        # Block layout: every line is scaled up to the width of the widest line,
        # so the headline is one big squared-off block (short lines get bigger).
        target = max(_measure(f, ln) for ln in lines)
        sizes = [int(min(size * 3, size * target / max(1, _measure(f, ln)))) for ln in lines]
        total = sum(s * lh for s in sizes)
        y = cy - total / 2
        for ln, s in zip(lines, sizes):
            y += s * lh / 2
            _draw_lines(draw, [ln], font(h.get("font", "Anton"), s), cx, y, s * lh, colors)
            y += s * lh / 2
    else:
        _draw_lines(draw, lines, f, cx, cy, size * lh, colors)
    if h.get("opacity", 1) < 1:
        a = img.getchannel("A").point(lambda v: int(v * h["opacity"]))
        img.putalpha(a)
    return img


def caption_image(style: dict, line: dict, active: int, since: float) -> tuple[Image.Image, int, int]:
    """Renders one caption line. Returns (image, left, top) in output coords."""
    words = [w["w"] for w in line["words"]]
    if style.get("uppercase", True):
        words = [w.upper() for w in words]
    size = int(style.get("size", 66))
    if style.get("animation", "pop") == "pop":
        size = int(size * (0.82 + 0.18 * ease(since / 0.12)))
    f = font(style.get("font", "Montserrat"), size)
    max_w = W * 0.9
    width = f.getlength(" ".join(words))
    if width > max_w:  # shrink long lines to fit
        size = int(size * max_w / width)
        f = font(style.get("font", "Montserrat"), size)
    stroke = max(0, int(style.get("stroke", 7) * size / max(1, style.get("size", 66))))
    keyed = [[(w, j == active) for j, w in enumerate(words)]]
    pad = stroke + 12 + int(size * 0.2)
    tw = int(f.getlength(" ".join(words))) + pad * 2
    th = int(size * 1.4) + pad * 2
    img = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
    is_box = style.get("highlightStyle") == "box"
    colors = {False: style.get("color", "#FFFFFF"),
              True: style.get("boxText", "#FFFFFF") if is_box else style.get("highlight", "#F2C230")}
    _draw_lines(ImageDraw.Draw(img), keyed, f, tw / 2, th / 2, size * 1.2, colors,
                stroke=stroke, stroke_color=style.get("strokeColor", "#000000"),
                box=style.get("highlight", "#E3202A") if is_box else None)
    cx, cy = style.get("x", 0.5) * W, style.get("y", 0.72) * H
    return img, int(cx - tw / 2), int(cy - th / 2)
