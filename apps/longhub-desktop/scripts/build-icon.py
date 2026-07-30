from base64 import b64encode
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
SOURCE = ASSETS / "longhub-avatar-source.png"


def resized_avatar(size: int) -> Image.Image:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"缺少龙枢头像源文件: {SOURCE}")
    with Image.open(SOURCE) as source:
        return ImageOps.fit(
            source.convert("RGBA"),
            (size, size),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )


def write_svg(icon: Image.Image) -> None:
    encoded = BytesIO()
    icon.save(encoded, format="PNG", optimize=True)
    payload = b64encode(encoded.getvalue()).decode("ascii")
    (ASSETS / "longhub-icon.svg").write_text(
        "\n".join(
            [
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="龙枢">',
                f'  <image width="256" height="256" href="data:image/png;base64,{payload}"/>',
                "</svg>",
                "",
            ]
        ),
        encoding="utf-8",
    )


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    avatar = resized_avatar(512)
    avatar.save(ASSETS / "longhub-avatar.png", format="PNG", optimize=True)

    icon = resized_avatar(256)
    icon.save(ASSETS / "longhub-icon.png", format="PNG", optimize=True)
    icon.save(
        ASSETS / "longhub-icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    write_svg(icon)


if __name__ == "__main__":
    main()
