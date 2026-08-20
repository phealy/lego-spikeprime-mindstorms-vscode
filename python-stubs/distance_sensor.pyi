"""Read and control a distance sensor connected to a hub port."""

from hub.port import Port

def clear(port: Port) -> None:
    """Turn off all distance-sensor lights."""
    ...

def distance(port: Port) -> int:
    """Return distance in millimeters, or -1 when unavailable."""
    ...

def get_pixel(port: Port, x: int, y: int) -> int:
    """Return one light's intensity as a percentage."""
    ...

def set_pixel(port: Port, x: int, y: int, intensity: int) -> None:
    """Set one light's intensity."""
    ...

def show(port: Port, pixels: list[int]) -> None:
    """Set all four light intensities at once."""
    ...