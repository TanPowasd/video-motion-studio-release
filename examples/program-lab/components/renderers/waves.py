import math

def render(ctx, params, input_rgba):
    width, height = ctx['width'], ctx['height']
    seconds = ctx['seconds']
    speed = float(params.get('speed', 1.0))
    pixels = bytearray(width * height * 4)
    for y in range(height):
        vy = y / height
        row = bytearray(width * 4)
        for x in range(width):
            vx = x / width
            wave = .5 + .5 * math.sin(vx * 15 + math.sin(vy * 8 - seconds * speed) * 3 - seconds * 2)
            distance = abs(vy - .5 - .18 * math.sin(vx * 9 + seconds * speed))
            line = math.exp(-distance * 80)
            at = x * 4
            row[at:at+4] = bytes([int(10 + wave * 28 + line * 110), int(22 + wave * 90 + line * 105), int(48 + wave * 70 + line * 110), 255])
        pixels[y*width*4:(y+1)*width*4] = row
    return pixels
