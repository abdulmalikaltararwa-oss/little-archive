#!/usr/bin/env python3
"""Render web/icon.svg into a macOS .iconset (then `iconutil` makes the .icns).

Runs inside the build virtual environment because it draws with AppKit (PyObjC).
The icon is drawn from the vector at every size, inside the standard macOS icon
grid: a 1024-point canvas with the artwork inset by 100 points on every side.
"""
import sys
from pathlib import Path

from AppKit import (
    NSBitmapImageRep, NSBitmapImageFileTypePNG, NSCompositingOperationSourceOver, NSDeviceRGBColorSpace,
    NSGraphicsContext, NSImage, NSImageInterpolationHigh,
)
from Foundation import NSMakeRect, NSZeroRect

SIZES = ((16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2))
INSET = 100 / 1024


def render(image, pixels, destination):
    rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, pixels, pixels, 8, 4, True, False, NSDeviceRGBColorSpace, 0, 0)
    rep.setSize_((pixels, pixels))
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.setCurrentContext_(NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep))
    NSGraphicsContext.currentContext().setImageInterpolation_(NSImageInterpolationHigh)
    margin = pixels * INSET
    image.setSize_((pixels, pixels))  # Vector artwork is rasterised at this size, not scaled afterwards.
    image.drawInRect_fromRect_operation_fraction_(
        NSMakeRect(margin, margin, pixels - 2 * margin, pixels - 2 * margin), NSZeroRect, NSCompositingOperationSourceOver, 1.0)
    NSGraphicsContext.restoreGraphicsState()
    data = rep.representationUsingType_properties_(NSBitmapImageFileTypePNG, {})
    if data is None or not data.writeToFile_atomically_(str(destination), True):
        raise SystemExit(f"Could not write {destination}")


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: make_icon.py ICON.svg OUTPUT.iconset")
    source, iconset = Path(argv[1]), Path(argv[2])
    iconset.mkdir(parents=True, exist_ok=True)
    for base, scale in SIZES:
        image = NSImage.alloc().initWithContentsOfFile_(str(source))
        if image is None:
            raise SystemExit(f"AppKit could not read {source}")
        render(image, base * scale, iconset / f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png")
    print(f"Rendered {len(SIZES)} icon sizes from {source.name}")


if __name__ == "__main__":
    main(sys.argv)
