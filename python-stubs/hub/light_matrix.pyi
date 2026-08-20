"""Control the 5 by 5 light matrix on the hub face."""

from typing import Awaitable, Final, TypeAlias
import orientation

MatrixImage: TypeAlias = int
LightMatrixStatus: TypeAlias = int

IMAGE_HEART: Final[MatrixImage] = 1
IMAGE_HEART_SMALL: Final[MatrixImage] = 2
IMAGE_HAPPY: Final[MatrixImage] = 3
IMAGE_SMILE: Final[MatrixImage] = 4
IMAGE_SAD: Final[MatrixImage] = 5
IMAGE_CONFUSED: Final[MatrixImage] = 6
IMAGE_ANGRY: Final[MatrixImage] = 7
IMAGE_ASLEEP: Final[MatrixImage] = 8
IMAGE_SURPRISED: Final[MatrixImage] = 9
IMAGE_SILLY: Final[MatrixImage] = 10
IMAGE_FABULOUS: Final[MatrixImage] = 11
IMAGE_MEH: Final[MatrixImage] = 12
IMAGE_YES: Final[MatrixImage] = 13
IMAGE_NO: Final[MatrixImage] = 14
IMAGE_CLOCK12: Final[MatrixImage] = 15
IMAGE_CLOCK1: Final[MatrixImage] = 16
IMAGE_CLOCK2: Final[MatrixImage] = 17
IMAGE_CLOCK3: Final[MatrixImage] = 18
IMAGE_CLOCK4: Final[MatrixImage] = 19
IMAGE_CLOCK5: Final[MatrixImage] = 20
IMAGE_CLOCK6: Final[MatrixImage] = 21
IMAGE_CLOCK7: Final[MatrixImage] = 22
IMAGE_CLOCK8: Final[MatrixImage] = 23
IMAGE_CLOCK9: Final[MatrixImage] = 24
IMAGE_CLOCK10: Final[MatrixImage] = 25
IMAGE_CLOCK11: Final[MatrixImage] = 26
IMAGE_ARROW_N: Final[MatrixImage] = 27
IMAGE_ARROW_NE: Final[MatrixImage] = 28
IMAGE_ARROW_E: Final[MatrixImage] = 29
IMAGE_ARROW_SE: Final[MatrixImage] = 30
IMAGE_ARROW_S: Final[MatrixImage] = 31
IMAGE_ARROW_SW: Final[MatrixImage] = 32
IMAGE_ARROW_W: Final[MatrixImage] = 33
IMAGE_ARROW_NW: Final[MatrixImage] = 34
IMAGE_GO_RIGHT: Final[MatrixImage] = 35
IMAGE_GO_LEFT: Final[MatrixImage] = 36
IMAGE_GO_UP: Final[MatrixImage] = 37
IMAGE_GO_DOWN: Final[MatrixImage] = 38
IMAGE_TRIANGLE: Final[MatrixImage] = 39
IMAGE_TRIANGLE_LEFT: Final[MatrixImage] = 40
IMAGE_CHESSBOARD: Final[MatrixImage] = 41
IMAGE_DIAMOND: Final[MatrixImage] = 42
IMAGE_DIAMOND_SMALL: Final[MatrixImage] = 43
IMAGE_SQUARE: Final[MatrixImage] = 44
IMAGE_SQUARE_SMALL: Final[MatrixImage] = 45
IMAGE_RABBIT: Final[MatrixImage] = 46
IMAGE_COW: Final[MatrixImage] = 47
IMAGE_MUSIC_CROTCHET: Final[MatrixImage] = 48
IMAGE_MUSIC_QUAVER: Final[MatrixImage] = 49
IMAGE_MUSIC_QUAVERS: Final[MatrixImage] = 50
IMAGE_PITCHFORK: Final[MatrixImage] = 51
IMAGE_XMAS: Final[MatrixImage] = 52
IMAGE_PACMAN: Final[MatrixImage] = 53
IMAGE_TARGET: Final[MatrixImage] = 54
IMAGE_TSHIRT: Final[MatrixImage] = 55
IMAGE_ROLLERSKATE: Final[MatrixImage] = 56
IMAGE_DUCK: Final[MatrixImage] = 57
IMAGE_HOUSE: Final[MatrixImage] = 58
IMAGE_TORTOISE: Final[MatrixImage] = 59
IMAGE_BUTTERFLY: Final[MatrixImage] = 60
IMAGE_STICKFIGURE: Final[MatrixImage] = 61
IMAGE_GHOST: Final[MatrixImage] = 62
IMAGE_SWORD: Final[MatrixImage] = 63
IMAGE_GIRAFFE: Final[MatrixImage] = 64
IMAGE_SKULL: Final[MatrixImage] = 65
IMAGE_UMBRELLA: Final[MatrixImage] = 66
IMAGE_SNAKE: Final[MatrixImage] = 67
SHOWING: Final[LightMatrixStatus] = 0
SUCCESS: Final[LightMatrixStatus] = 1
CANCELLED: Final[LightMatrixStatus] = 2

def clear() -> None:
    """Turn off every matrix pixel."""
    ...

def get_orientation() -> orientation.Orientation:
    """Return the current display orientation."""
    ...

def get_pixel(x: int, y: int) -> int:
    """Return one pixel's intensity."""
    ...

def set_orientation(top: orientation.Orientation) -> orientation.Orientation:
    """Set which side of the display is treated as the top."""
    ...

def set_pixel(x: int, y: int, intensity: int) -> None:
    """Set one pixel's intensity."""
    ...

def show(pixels: list[int]) -> None:
    """Set all 25 pixel intensities at once."""
    ...

def show_image(image: MatrixImage) -> None:
    """Show a built-in image."""
    ...

def write(
    text: str, intensity: int = 100, time_per_character: int = 500
) -> Awaitable[LightMatrixStatus]:
    """Return an awaitable that scrolls text across the matrix."""
    ...