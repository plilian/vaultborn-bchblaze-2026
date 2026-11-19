"""Extract individual WebP game textures from the project’s generated illustrations."""
from argparse import ArgumentParser
from pathlib import Path
import json

import numpy as np
from PIL import Image

ASSETS = Path(__file__).resolve().parents[1] / 'packages' / 'assets'


def write(im, name, size=None, quality=91):
    if size:
        im.thumbnail(size, Image.Resampling.LANCZOS)
    im.save(ASSETS / f'{name}.webp', quality=quality, method=6)


def split(path, cols, rows, inset=0):
    sheet = Image.open(path)
    for i in range(cols * rows):
        x, y = i % cols, i // cols
        yield sheet.crop((round(sheet.width*x/cols)+inset, round(sheet.height*y/rows)+inset,
                          round(sheet.width*(x+1)/cols)-inset, round(sheet.height*(y+1)/rows)-inset))


def transparent_crop(im, pad, mode='alpha'):
    px = np.array(im.convert('RGBA'))
    rgb = px[:,:,:3].astype(np.float32)
    if mode=='magenta':
        score = np.minimum(rgb[:,:,0], rgb[:,:,2])-rgb[:,:,1]
        px[:,:,3] = np.clip((105-score)*255/78, 0, 255).astype('uint8')
    else:
        a = px[:,:,3].astype(np.float32)
        px[:,:,3] = np.clip((a-22)*255/221, 0, 255).astype('uint8')
    im = Image.fromarray(px)
    bounds = im.getbbox(alpha_only=True)
    if bounds:
        im = im.crop(bounds)
    result = Image.new('RGBA', (im.width+2*pad,im.height+2*pad))
    result.alpha_composite(im, (pad,pad))
    return result


def main():
    parser = ArgumentParser(description=__doc__)
    for name in ('terrain','castles','heroes','events','architecture','tiers','troops','battlefield'):
        parser.add_argument('--'+name, type=Path)
    args = parser.parse_args()
    if args.terrain:
        write(Image.open(args.terrain).convert('RGB'), 'terrain', (1920,1200), 92)
    if args.battlefield:
        write(Image.open(args.battlefield).convert('RGB'), 'battlefield', (1672,941), 91)
    if args.castles:
        for name, image in zip(('emerald','azure','crimson','violet','gold','desert'), split(args.castles,3,2)):
            write(transparent_crop(image,5), 'castle-'+name, (512,512))
    if args.heroes:
        for name, image in zip(('warden','engineer','keeper','commander','ranger','queen','merchant','scholar'),split(args.heroes,4,2,2)):
            write(image,'hero-'+name,(440,440))
    if args.events:
        for name, image in zip(('victory','defeat','rebellion','protectorate','season','vault'),split(args.events,3,2,2)):
            write(image,'event-'+name,(640,470))
    roles = ('hall','barracks','walls','vault','workshop','market','library','alliance','scout','farm')
    if args.architecture:
        for name,image in zip(roles,split(args.architecture,5,2)):
            write(transparent_crop(image,10,'magenta'),name+'-1',(320,320))
    if args.tiers:
        for i, image in enumerate(split(args.tiers, 5, 4)):
            write(transparent_crop(image,9,'magenta'),roles[i%10]+'-'+str(2+i//10),(295,295))
    if args.troops:
        for name, image in zip(('infantry','shield','archer','cavalry','siege','mage'),split(args.troops,3,2)):
            base = transparent_crop(image,4,'magenta')
            write(base,'unit-'+name,(320,320))
            pixels = np.array(base).astype(np.float32)
            r, g, b = (pixels[:,:,i].copy() for i in range(3))
            dye = np.clip((g-np.maximum(r,b)-12)/40,0,1)
            pixels[:,:,0] = r*(1-dye) + np.minimum(255,g*1.18)*dye
            pixels[:,:,1] = g*(1-dye) + (r*.62+b*.12)*dye
            pixels[:,:,2] = b*(1-dye) + (b*.74+r*.12)*dye
            write(Image.fromarray(pixels.astype('uint8')),'unit-'+name+'-crimson',(320,320))
    items = []
    for path in sorted(ASSETS.glob('*.webp')):
        item = {'path':path.name, 'size':Image.open(path).size, 'frames':1, 'attribution':'BCH Dominion original art'}
        if path.name == 'terrain.webp': item['use'] = 'World panorama'; item['production'] = 'Codex ImageGen'
        elif path.name == 'battlefield.webp': item['use'] = 'Battle replay scenery'; item['production'] = 'Codex ImageGen'
        elif path.name.startswith('castle-'): item['use'] = 'Map settlement sprites'; item['production'] = 'Codex ImageGen'
        elif path.name.startswith('hero-'): item['use'] = 'Commander portraits'; item['production'] = 'Codex ImageGen'
        elif path.name.startswith('event-'): item['use'] = 'World and event key art'; item['production'] = 'Codex ImageGen'
        elif path.name.startswith('unit-'):
            item['use'] = 'Battle troop sprites'
            item['production'] = 'Codex ImageGen with faction palette variant' if path.stem.endswith('-crimson') else 'Codex ImageGen'
        else:
            item['use'] = 'City structure progression'
            item['production'] = 'Codex ImageGen'
        items.append(item)
    manifest = {'version':2,'license':'MIT for project-authored material where applicable','source':'Original art directed from the project reference boards','assets':items}
    if (ASSETS/'frontier-score.mp3').is_file():
        manifest['audio'] = [{'path':'frontier-score.mp3','title':'March of the Riverwardens','use':'Campaign music',
                              'attribution':'VAULTBORN original score','production':'scripts/render-score.py'}]
    (ASSETS/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')


if __name__ == '__main__':
    main()
