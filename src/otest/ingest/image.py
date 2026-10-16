"""Georeferenced image maps: JPG/PNG with a world file, KMZ overlays and GeoTIFFs."""

from __future__ import annotations

import io
import math
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
import numpy.typing as npt
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.transform import Affine
from rasterio.warp import Resampling, reproject

from otest.ingest.georef import Extent, etrs89_utm_epsg

# Image maps are large, and come from the user.
Image.MAX_IMAGE_PIXELS = None

WORLD_FILE_SUFFIXES = {
    ".jpg": (".jgw", ".jpgw", ".wld"),
    ".jpeg": (".jgw", ".jpegw", ".wld"),
    ".png": (".pgw", ".pngw", ".wld"),
    ".gif": (".gfw", ".wld"),
    ".tif": (".tfw", ".tifw", ".wld"),
    ".tiff": (".tfw", ".tiffw", ".wld"),
}
KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


class ImageMapError(ValueError):
    """The image map cannot be read or georeferenced."""


@dataclass(frozen=True)
class ImageMap:
    """An image map with its georeference.

    Attributes:
        rgb: Image pixels, rows from the top.
        transform: Affine transform from pixel corners to projected coordinates.
        epsg: ETRS89 / UTM EPSG code of the transform.
    """

    rgb: npt.NDArray[np.uint8]
    transform: Affine
    epsg: int

    @property
    def bounds(self) -> Extent:
        """Projected bounding box of the image."""
        rows, cols = self.rgb.shape[:2]
        corners = [
            self.transform @ (c, r)
            for c, r in ((0, 0), (cols, 0), (0, rows), (cols, rows))
        ]
        xs, ys = zip(*corners, strict=True)
        return Extent(min(xs), min(ys), max(xs), max(ys))

    @property
    def metres_per_pixel(self) -> float:
        """Ground size of one pixel."""
        return math.sqrt(abs(self.transform.determinant))

    def resample(
        self,
        extent: Extent,
        px_per_m: float,
        resampling: Resampling = Resampling.nearest,
    ) -> npt.NDArray[np.uint8]:
        """Return the image resampled to a north-up grid covering ``extent``.

        Pixels outside the image are 0 (black), which is never a valid map colour
        together with the alpha-like check in the classifier.
        """
        rows = round(extent.height * px_per_m)
        cols = round(extent.width * px_per_m)
        out = np.zeros((3, rows, cols), dtype=np.uint8)
        dst_transform = Affine(1 / px_per_m, 0, extent.x0, 0, -1 / px_per_m, extent.y1)
        for band in range(3):
            reproject(
                np.ascontiguousarray(self.rgb[..., band]),
                out[band],
                src_transform=self.transform,
                src_crs=f"EPSG:{self.epsg}",
                dst_transform=dst_transform,
                dst_crs=f"EPSG:{self.epsg}",
                resampling=resampling,
            )
        return np.moveaxis(out, 0, -1)

    def coverage(self, extent: Extent, px_per_m: float) -> npt.NDArray[np.bool_]:
        """True for grid cells covered by the image."""
        ones = np.ones(self.rgb.shape[:2], dtype=np.uint8)
        rows = round(extent.height * px_per_m)
        cols = round(extent.width * px_per_m)
        out = np.zeros((rows, cols), dtype=np.uint8)
        reproject(
            ones,
            out,
            src_transform=self.transform,
            src_crs=f"EPSG:{self.epsg}",
            dst_transform=Affine(
                1 / px_per_m, 0, extent.x0, 0, -1 / px_per_m, extent.y1
            ),
            dst_crs=f"EPSG:{self.epsg}",
            resampling=Resampling.nearest,
        )
        covered: npt.NDArray[np.bool_] = out > 0
        return covered


def parse_world_file(text: str) -> Affine:
    r"""Parse a world file (pixel-centre georeference) into a pixel-corner transform.

    Examples:
        >>> t = parse_world_file("2.0\n0\n0\n-2.0\n1001.0\n5999.0\n")
        >>> t @ (0, 0), t @ (1, 1)
        ((1000.0, 6000.0), (1002.0, 5998.0))
    """
    values = [float(v) for v in text.split()]
    if len(values) != 6:
        msg = "A world file must have six numbers"
        raise ImageMapError(msg)
    a, d, b, e, c, f = values
    # World files give the centre of the upper-left pixel; move to its corner.
    return Affine(a, b, c - a / 2 - b / 2, d, e, f - d / 2 - e / 2)


def utm_epsg_for_longitude(lon: float) -> int:
    """ETRS89 / UTM zone used in Norway for a longitude (zones 32, 33 or 35).

    Examples:
        >>> utm_epsg_for_longitude(10.7), utm_epsg_for_longitude(15.0), utm_epsg_for_longitude(25.0)
        (25832, 25833, 25835)
    """
    zone = math.floor((lon + 180) / 6) + 1
    zone = 32 if zone <= 32 else 33 if zone <= 34 else 35
    return 25800 + zone


def _load_rgb(data: bytes | Path) -> npt.NDArray[np.uint8]:
    source = io.BytesIO(data) if isinstance(data, bytes) else data
    with Image.open(source) as img:
        background = Image.new("RGB", img.size, "white")
        rgba = img.convert("RGBA")
        background.paste(rgba, mask=rgba.getchannel("A"))
        return np.asarray(background)


def _read_kmz(path: Path) -> ImageMap:
    with zipfile.ZipFile(path) as kmz:
        kml_name = next((n for n in kmz.namelist() if n.lower().endswith(".kml")), None)
        if kml_name is None:
            msg = f"No KML document in {path.name}"
            raise ImageMapError(msg)
        root = ET.fromstring(kmz.read(kml_name))  # noqa: S314 - local file
        overlay = root.find(".//kml:GroundOverlay", KML_NS)
        if overlay is None:
            msg = f"No GroundOverlay in {path.name}"
            raise ImageMapError(msg)
        href = overlay.findtext("kml:Icon/kml:href", namespaces=KML_NS)
        box = overlay.find("kml:LatLonBox", KML_NS)
        if href is None or box is None:
            msg = f"The GroundOverlay in {path.name} has no image or LatLonBox"
            raise ImageMapError(msg)

        def coord(tag: str) -> float:
            return float(box.findtext(f"kml:{tag}", default="0", namespaces=KML_NS))

        north, south, east, west = (
            coord("north"),
            coord("south"),
            coord("east"),
            coord("west"),
        )
        rotation = math.radians(coord("rotation"))
        rgb = _load_rgb(kmz.read(href))

    # Rotate the box corners about its centre (KML rotation is counter-clockwise),
    # in a local metric frame so the rotation is not distorted by longitude scaling.
    lon0, lat0 = (east + west) / 2, (north + south) / 2
    epsg = utm_epsg_for_longitude(lon0)
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
    cx, cy = to_utm.transform(lon0, lat0)
    xw, _ = to_utm.transform(west, lat0)
    xe, _ = to_utm.transform(east, lat0)
    _, yn = to_utm.transform(lon0, north)
    _, ys = to_utm.transform(lon0, south)
    half_w, half_h = (xe - xw) / 2, (yn - ys) / 2
    cos, sin = math.cos(rotation), math.sin(rotation)

    def corner(dx: float, dy: float) -> tuple[float, float]:
        return cx + dx * cos - dy * sin, cy + dx * sin + dy * cos

    ul = corner(-half_w, half_h)
    ur = corner(half_w, half_h)
    ll = corner(-half_w, -half_h)
    rows, cols = rgb.shape[:2]
    transform = Affine(
        (ur[0] - ul[0]) / cols,
        (ll[0] - ul[0]) / rows,
        ul[0],
        (ur[1] - ul[1]) / cols,
        (ll[1] - ul[1]) / rows,
        ul[1],
    )
    return ImageMap(rgb=rgb, transform=transform, epsg=epsg)


def read_image_map(path: Path, epsg: int | None = None) -> ImageMap:
    """Read an image map and its georeference.

    Args:
        path: A ``.kmz`` overlay, a GeoTIFF, or an image with a world file next to it.
        epsg: EPSG code of the world file's coordinates (required for world files,
            which do not say which coordinate system they use).

    Raises:
        ImageMapError: If the georeference is missing or unsupported.
    """
    suffix = path.suffix.lower()
    if suffix == ".kmz":
        return _read_kmz(path)

    if suffix in (".tif", ".tiff"):
        with rasterio.open(path) as src:
            if src.crs is not None and src.transform != Affine.identity():
                data = (
                    src.read([1, 2, 3])
                    if src.count >= 3
                    else np.repeat(src.read(1)[None], 3, 0)
                )
                code = src.crs.to_epsg()
                if code is None:
                    msg = f"Unknown coordinate system in {path.name}"
                    raise ImageMapError(msg)
                rgb = np.moveaxis(data, 0, -1).astype(np.uint8)
                return ImageMap(
                    rgb=rgb, transform=src.transform, epsg=etrs89_utm_epsg(code)
                )

    for world_suffix in WORLD_FILE_SUFFIXES.get(suffix, (".wld",)):
        world_file = path.with_suffix(world_suffix)
        if world_file.is_file():
            if epsg is None:
                msg = (
                    f"{world_file.name} does not say which coordinate system it uses; "
                    "give it with --epsg (for example 25832 or 25833)"
                )
                raise ImageMapError(msg)
            transform = parse_world_file(world_file.read_text(encoding="utf-8"))
            return ImageMap(
                rgb=_load_rgb(path), transform=transform, epsg=etrs89_utm_epsg(epsg)
            )

    msg = f"No georeference found for {path.name}: add a world file, or use KMZ or GeoTIFF"
    raise ImageMapError(msg)
