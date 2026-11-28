#!/usr/bin/env python3
"""Index loose Deus Ex packages/configuration without copying game assets."""
import argparse
import hashlib
import json
from pathlib import Path

FOLDERS = {'System': {'.u', '.ini', '.int'}, 'Maps': {'.dx', '.unr'},
           'Textures': {'.utx'}, 'Sounds': {'.uax'}, 'Music': {'.umx'}}

def manifest(root):
    files = []
    for folder, extensions in FOLDERS.items():
        directory = root / folder
        if not directory.is_dir():
            raise ValueError(f'Missing asset directory: {directory}')
        for path in sorted(directory.iterdir()):
            if path.is_file() and path.suffix.lower() in extensions:
                data = path.read_bytes()
                files.append({'path': path.relative_to(root).as_posix(), 'size': len(data),
                              'sha256': hashlib.sha256(data).hexdigest(),
                              'startup': path.suffix.lower() in {'.ini', '.int'}})
    for required in ('System/Core.u', 'System/Engine.u', 'System/DeusEx.u', 'System/Default.ini', 'System/DefUser.ini'):
        if not any(item['path'] == required for item in files):
            raise ValueError(f'Missing required asset: {required}')
    return {'version': 1, 'files': files}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('game_data', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = manifest(args.game_data)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(f'Indexed {len(result["files"])} files; {sum(x["size"] for x in result["files"]):,} bytes')
