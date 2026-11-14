"""Thumbnail validation and local storage, shared by manual uploads and the stored copy.

This is the original upload path moved out of ``app.py`` unchanged in behaviour: only PNG,
JPEG or WebP under 20 megapixels is decoded, orientation is applied, the image is bounded
to 1600 px and always re-encoded as PNG, so what is stored is never the downloaded bytes.
"""
from __future__ import annotations

import hashlib
import io
import os
import secrets


def reencode_image(raw: bytes) -> bytes:
    """Decode a raster image and return a fresh, bounded PNG. Raises ValueError for anything else."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(raw)) as im:
            if im.format not in {"PNG", "JPEG", "WEBP"} or im.width * im.height > 20000000:
                raise ValueError("Use a PNG, JPEG, or WebP image under 20 megapixels.")
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((1600, 1600))
            output = io.BytesIO()
            im.save(output, format="PNG", optimize=True)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise ValueError("That file could not be decoded as a safe image.")


def write_asset(store, blob: bytes) -> str:
    """Write a content-addressed PNG into the library's asset folder and return its digest."""
    digest = hashlib.sha256(blob).hexdigest()
    target = store.assets / (digest + ".png")
    with store.lock:
        if not target.exists():
            temporary = store.assets / ("." + secrets.token_hex(16) + ".tmp")
            try:
                with open(temporary, "xb") as f:
                    f.write(blob)
                    f.flush()
                    os.fsync(f.fileno())
                temporary.chmod(0o600)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
    return digest
