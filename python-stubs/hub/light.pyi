"""Control status lights on the hub."""

from typing import Final, TypeAlias
import color as color_module

Light: TypeAlias = int

POWER: Final[Light] = 0
CONNECT: Final[Light] = 1

def color(light: Light, color: color_module.Color) -> None:
    """Set a status light to a color identifier."""
    ...