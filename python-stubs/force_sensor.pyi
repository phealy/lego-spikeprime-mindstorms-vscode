"""Read a force sensor connected to a hub port."""

from hub.port import Port

def force(port: Port) -> int:
    """Return measured force in decinewtons."""
    ...

def pressed(port: Port) -> bool:
    """Return whether the sensor is pressed."""
    ...

def raw(port: Port) -> int:
    """Return the raw, uncalibrated force value."""
    ...