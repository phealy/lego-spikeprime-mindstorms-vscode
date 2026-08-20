"""Read buttons on the hub."""

from typing import Final, TypeAlias

Button: TypeAlias = int

LEFT: Final[Button] = 0
POWER: Final[Button] = 1
RIGHT: Final[Button] = 2
CONNECT: Final[Button] = 3

def pressed(button: Button) -> int:
    """Return how long a button has been pressed in milliseconds."""
    ...