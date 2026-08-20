"""Control a color matrix connected to a hub port."""

import color
from hub.port import Port

def clear(port: Port) -> None:
    """Turn off every pixel."""
    ...

def get_pixel(port: Port, x: int, y: int) -> tuple[color.Color, int]:
    """Return a pixel as a ``(color, intensity)`` tuple."""
    ...

def set_pixel(
    port: Port, x: int, y: int, pixel: tuple[color.Color, int]
) -> None:
    """Set one pixel from a ``(color, intensity)`` tuple."""
    ...

def show(port: Port, pixels: list[tuple[color.Color, int]]) -> None:
    """Set all pixels at once."""
    ...