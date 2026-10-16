"""Distinct precipitation phases; no temperature-only snow guesses."""
import numpy as np
from PIL import Image, ImageDraw

RAIN, SNOW, MIXED, FREEZING, ICE = 1, 2, 3, 4, 5

def ecmwf_phase(values):
    result=np.zeros(np.shape(values),dtype=np.uint8)
    for codes,phase in [([1,11],RAIN),([5,6],SNOW),([7],MIXED),([3,12],FREEZING),([8],ICE)]:
        result[np.isin(values,codes)]=phase
    return result

def nordic_phase(image):
    # WMS encodes <30% blue, >70% magenta, 30–70% black/white.
    # Transparent missing pixels stay unknown, never assumed rain or snow.
    pixels=np.array(image.convert('RGBA'));result=np.zeros(pixels.shape[:2],dtype=np.uint8)
    valid=pixels[:,:,3]>0
    result[valid&(np.all(pixels[:,:,:3]==[0,0,0],axis=2)|np.all(pixels[:,:,:3]==[255,255,255],axis=2))]=MIXED
    result[valid&np.all(pixels[:,:,:3]==[0,136,255],axis=2)]=RAIN
    result[valid&np.all(pixels[:,:,:3]==[255,0,255],axis=2)]=SNOW
    return result

def paint_phase(image,phase):
    """Keep rain intensity, recolour other phases, and stamp snowflakes."""
    pixels=np.array(image.convert('RGBA'));phase=np.asarray(phase)
    if phase.shape!=pixels.shape[:2]:raise ValueError('Precipitation phase dimensions differ')
    wet=pixels[:,:,3]>0
    for code,colour in [(0,(149,163,179)),(SNOW,(234,94,218)),(MIXED,(255,194,103)),(FREEZING,(255,64,85)),(ICE,(114,229,244))]:
        mask=wet&(phase==code);pixels[mask,:3]=colour
    output=Image.fromarray(pixels);draw=ImageDraw.Draw(output)
    # Six-spoke white snowflakes make snow distinguishable beyond colour.
    height,width=phase.shape;spacing=max(16,round(width/32));radius=max(3,round(width/300))
    for y in range(spacing//2,height,spacing):
        for x in range(spacing//2,width,spacing):
            if wet[y,x] and phase[y,x]==SNOW:
                for dx,dy in [(0,radius),(radius,round(radius*.55)),(radius,-round(radius*.55))]:
                    draw.line((x-dx,y-dy,x+dx,y+dy),fill=(255,255,255,255),width=max(1,width//1000))
    painted=np.array(output);snow=wet&(phase==SNOW);painted[~snow]=pixels[~snow]
    return Image.fromarray(painted)

def recolour_nordic(rain_path,phase_path):
    with Image.open(rain_path) as rain,Image.open(phase_path) as phase:
        paint_phase(rain,nordic_phase(phase)).save(rain_path,format='WEBP',lossless=True,method=4)
