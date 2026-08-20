"""Read a color sensor connected to a hub port."""

import color as color_module
from hub.port import Port

def color(port: Port) -> color_module.Color:
    """Return the detected color identifier."""
    ...

def reflection(port: Port) -> int:
    """Return reflected-light intensity as a percentage."""
    ...

def rgbi(port: Port) -> tuple[int, int, int, int]:
    """Return red, green, blue, and overall intensity values."""
    ...