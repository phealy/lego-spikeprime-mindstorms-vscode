"""Read and configure the hub motion sensor."""

from typing import Final, TypeAlias

Gesture: TypeAlias = int
HubFace: TypeAlias = int

TAPPED: Final[Gesture] = 0
DOUBLE_TAPPED: Final[Gesture] = 1
SHAKEN: Final[Gesture] = 2
FALLING: Final[Gesture] = 3
UNKNOWN: Final[Gesture] = -1
TOP: Final[HubFace] = 0
FRONT: Final[HubFace] = 1
RIGHT: Final[HubFace] = 2
BOTTOM: Final[HubFace] = 3
BACK: Final[HubFace] = 4
LEFT: Final[HubFace] = 5

def acceleration(raw_unfiltered: bool) -> tuple[int, int, int]:
    """Return acceleration on the x, y, and z axes."""
    ...

def angular_velocity(raw_unfiltered: bool) -> tuple[int, int, int]:
    """Return angular velocity on the x, y, and z axes."""
    ...

def gesture() -> Gesture:
    """Return the detected gesture identifier."""
    ...

def get_yaw_face() -> HubFace:
    """Return the face used for yaw calculations."""
    ...

def quaternion() -> tuple[float, float, float, float]:
    """Return orientation as a quaternion."""
    ...

def reset_tap_count() -> None:
    """Reset the tap counter."""
    ...

def reset_yaw(angle: int) -> None:
    """Reset yaw to an angle from -180 to 179 degrees."""
    ...

def set_yaw_face(up: HubFace) -> bool:
    """Set the face used for yaw calculations."""
    ...

def stable() -> bool:
    """Return whether the hub is stable."""
    ...

def tap_count() -> int:
    """Return the number of detected taps."""
    ...

def tilt_angles() -> tuple[int, int, int]:
    """Return yaw, pitch, and roll angles in decidegrees."""
    ...

def up_face() -> HubFace:
    """Return the face currently pointing upward."""
    ...