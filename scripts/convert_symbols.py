"""Convert Purple Pen's control description symbols to JSON for the viewer.

Purple Pen (https://github.com/petergolde/PurplePen, BSD licence, © Peter Golde)
describes every IOF control description symbol with vector drawing commands in a
200 x 200 box centred on (0, 0), y up, and names it in many languages. This keeps the
drawings and the English and Norwegian (bokmål) names:

    uv run scripts/convert_symbols.py path/to/symbols.xml viewer/src/descriptions/symbols.json

Each symbol becomes ``{"kind": "D", "names": {"en": ..., "nb": ...}, "shapes": [...]}``.
A shape is a list starting with its type:

    ["lines", thickness, round_ends, round_corners, x0, y0, x1, y1, ...]
    ["polygon", thickness, round_corners, x0, y0, ...]
    ["filled-polygon", x0, y0, ...]
    ["circle", thickness, radius, x, y]
    ["filled-circle", radius, x, y]
    ["beziers", thickness, round_ends, x0, y0, ...]
    ["filled-beziers", x0, y0, ...]
"""

from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

LANGUAGES = {"en": "en", "nb": "nb-NO"}
SHAPES = {
    "lines",
    "polygon",
    "filled-polygon",
    "circle",
    "filled-circle",
    "beziers",
    "filled-beziers",
}
# Symbols that exist in a 2004 and a 2018 version; the viewer follows IOF 2018/2024.
PREFERRED_STANDARD = "2018"


def _number(text: str | None) -> float:
    value = float(text or 0)
    return int(value) if value.is_integer() else round(value, 2)


def _points(element: ET.Element) -> list[float]:
    return [
        v
        for p in element.findall("point")
        for v in (_number(p.get("x")), _number(p.get("y")))
    ]


def _shape(element: ET.Element) -> list[Any]:
    tag = element.tag
    thickness = _number(element.get("thickness"))
    round_ends = int(element.get("ends", "round") == "round")
    round_corners = int(element.get("corners", "round") == "round")
    if tag == "lines":
        return [tag, thickness, round_ends, round_corners, *_points(element)]
    if tag == "polygon":
        return [tag, thickness, round_corners, *_points(element)]
    if tag == "circle":
        return [tag, thickness, _number(element.get("radius")), *_points(element)]
    if tag == "filled-circle":
        return [tag, _number(element.get("radius")), *_points(element)]
    if tag == "beziers":
        return [tag, thickness, round_ends, *_points(element)]
    return [tag, *_points(element)]


def convert(source: Path) -> dict[str, Any]:
    """Return the symbols in ``source`` keyed by their Purple Pen id."""
    root = ET.parse(source).getroot()  # noqa: S314 - a local file chosen by the developer
    symbols: dict[str, Any] = {}
    for symbol in root.iter("symbol"):
        sid = symbol.get("id", "")
        standard = symbol.get("standard")
        if sid in symbols and standard != PREFERRED_STANDARD:
            continue
        names = {}
        for short, lang in LANGUAGES.items():
            name = next(
                (n.text for n in symbol.findall("name") if n.get("lang") == lang), None
            )
            if name:
                names[short] = name.strip()
        symbols[sid] = {
            "kind": symbol.get("kind"),
            "names": names,
            "shapes": [_shape(e) for e in symbol if e.tag in SHAPES],
        }
    return symbols


def main() -> None:
    """Command line entry point."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path, help="Purple Pen's symbols.xml")
    parser.add_argument("target", type=Path, help="JSON file to write")
    args = parser.parse_args()
    symbols = convert(args.source)
    data = {
        "source": "Purple Pen symbols.xml, © Peter Golde, BSD licence",
        "symbols": symbols,
    }
    args.target.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(symbols)} symbols to {args.target}")


if __name__ == "__main__":
    main()
