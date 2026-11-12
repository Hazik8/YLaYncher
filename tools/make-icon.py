"""Generate the Y LaYncher app icon (pixel-art Y on a dark rounded tile)."""

from PIL import Image, ImageDraw, ImageFilter
import os

SIZE = 512
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")
os.makedirs(OUT_DIR, exist_ok=True)

# --- background -----------------------------------------------------------
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# soft outer glow
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gdraw = ImageDraw.Draw(glow)
for i in range(60, 0, -1):
    alpha = int(1.6 * i)
    gdraw.rounded_rectangle(
        (60 - i, 60 - i, SIZE - 60 + i, SIZE - 60 + i),
        radius=110 + i,
        outline=(132, 245, 90, alpha),
        width=2,
    )
glow = glow.filter(ImageFilter.GaussianBlur(18))
img.alpha_composite(glow)

# tile
tile = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
tdraw = ImageDraw.Draw(tile)
for y in range(SIZE):
    t = y / SIZE
    r = int(17 + 5 * t)
    g = int(21 + 12 * t)
    b = int(31 + 16 * t)
    tdraw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))
tile = tile.filter(ImageFilter.GaussianBlur(0.4))
mask = Image.new("L", (SIZE, SIZE), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle((34, 34, SIZE - 34, SIZE - 34), radius=104, fill=255)
tile.putalpha(mask)
img.alpha_composite(tile)

# subtle grid
grid = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gdraw = ImageDraw.Draw(grid)
step = 44
for x in range(34, SIZE - 34, step):
    gdraw.line([(x, 40), (x, SIZE - 40)], fill=(255, 255, 255, 8), width=1)
for y in range(34, SIZE - 34, step):
    gdraw.line([(40, y), (SIZE - 40, y)], fill=(255, 255, 255, 8), width=1)
grid.putalpha(Image.composite(grid.split()[3], Image.new("L", (SIZE, SIZE), 0), mask))
img.alpha_composite(grid)

# inner vignette glow (green, behind the letter)
aura = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
adraw = ImageDraw.Draw(aura)
adraw.ellipse((120, 100, SIZE - 120, SIZE - 100), fill=(132, 245, 90, 46))
aura = aura.filter(ImageFilter.GaussianBlur(46))
img.alpha_composite(aura)

# --- pixel Y --------------------------------------------------------------
# 11 x 11 grid, each cell 26 px, centered
CELL = 26
GAP = 3
GRID = 11
origin_x = (SIZE - (GRID * CELL)) // 2
origin_y = (SIZE - (GRID * CELL)) // 2 + 4

pattern = [
    "X.........X",
    "X.........X",
    ".X.......X.",
    ".X.......X.",
    "..X.....X..",
    "...X...X...",
    "....X.X....",
    ".....X.....",
    ".....X.....",
    ".....X.....",
    ".....X.....",
]

letter = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ldraw = ImageDraw.Draw(letter)
blocks = []
for row, line in enumerate(pattern):
    for col, ch in enumerate(line):
        if ch != "X":
            continue
        x = origin_x + col * CELL
        y = origin_y + row * CELL
        blocks.append((x, y, row, col))

# shadow / extrusion
for x, y, row, col in blocks:
    ldraw.rounded_rectangle(
        (x + 7, y + 9, x + CELL - GAP + 7, y + CELL - GAP + 9),
        radius=6,
        fill=(4, 8, 5, 160),
    )
letter = letter.filter(ImageFilter.GaussianBlur(3))
img.alpha_composite(letter)

letter = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ldraw = ImageDraw.Draw(letter)
for x, y, row, col in blocks:
    t = (row + col) / (GRID * 2 - 2)
    r = int(150 + 48 * t)
    g = int(248 - 10 * t)
    b = int(86 + 54 * t)
    ldraw.rounded_rectangle(
        (x, y, x + CELL - GAP, y + CELL - GAP),
        radius=5,
        fill=(r, g, b, 255),
    )
    # pixel highlight
    ldraw.rounded_rectangle(
        (x + 3, y + 3, x + CELL - GAP - 3, y + 10),
        radius=2,
        fill=(255, 255, 255, 52),
    )
img.alpha_composite(letter)

# purple accent block (Fabric-ish spark)
accent_x = origin_x + GRID * CELL - 4
accent_y = origin_y + 2 * CELL
for dx, dy, color in [
    (0, 0, (147, 121, 255, 255)),
    (27, 0, (120, 94, 230, 255)),
    (0, 27, (170, 148, 255, 255)),
    (27, 27, (100, 76, 200, 255)),
]:
    draw.rounded_rectangle(
        (accent_x + dx, accent_y + dy, accent_x + dx + 22, accent_y + dy + 22),
        radius=5,
        fill=color,
    )
draw.rounded_rectangle(
    (accent_x, accent_y, accent_x + 22, accent_y + 7),
    radius=3,
    fill=(205, 195, 255, 90),
)

# outer border
border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bdraw = ImageDraw.Draw(border)
bdraw.rounded_rectangle((34, 34, SIZE - 34, SIZE - 34), radius=104, outline=(255, 255, 255, 28), width=2)
img.alpha_composite(border)

png_path = os.path.join(OUT_DIR, "icon.png")
img.save(png_path)

ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(os.path.join(OUT_DIR, "icon.ico"), sizes=ico_sizes)
print("saved", png_path)
