#!/usr/bin/env python3
"""Scaffold a new thoughts post.

Usage (run from the personal_site folder):
  python scripts/new-post.py "my post title" --summary "one-liner for the list + RSS"

Options:
  --slug   override the auto-generated slug
  --date   YYYY-MM-DD (default: today)
  --log    also add a brief homepage log entry with this text;
           if the text contains the post title, the title becomes the link,
           otherwise a "more →" link is appended

Then: write the body in data/posts/<slug>.md, commit, push.
"""
import argparse
import datetime
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTS = ROOT / 'data' / 'posts'
CONTENT = ROOT / 'data' / 'content.json'


def slugify(title):
    s = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
    if not s:
        sys.exit('error: title produced an empty slug')
    return s


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f, object_pairs_hook=OrderedDict)


def save(path, data):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')


def main():
    ap = argparse.ArgumentParser(description='scaffold a new thoughts post')
    ap.add_argument('title')
    ap.add_argument('--summary', default='')
    ap.add_argument('--slug')
    ap.add_argument('--date', default=datetime.date.today().isoformat())
    ap.add_argument('--log', help='brief homepage log entry text')
    args = ap.parse_args()

    slug = args.slug or slugify(args.title)
    md = POSTS / f'{slug}.md'
    if md.exists():
        sys.exit(f'error: {md} already exists')

    manifest = load(POSTS / 'index.json')
    if any(p['slug'] == slug for p in manifest['posts']):
        sys.exit(f'error: slug "{slug}" already in index.json')

    md.write_text('Write your post here.\n', encoding='utf-8', newline='\n')
    manifest['posts'].insert(0, OrderedDict([
        ('slug', slug),
        ('title', args.title),
        ('date', args.date),
        ('summary', args.summary),
    ]))
    save(POSTS / 'index.json', manifest)
    print(f'created  {md}')
    print(f'indexed  {slug} ({args.date})')

    if args.log:
        content = load(CONTENT)
        href = f'#/thoughts/{slug}'
        body = args.log
        if args.title in body:
            link = OrderedDict([('text', args.title), ('href', href)])
        else:
            body = body.rstrip() + ' more →'
            link = OrderedDict([('text', 'more →'), ('href', href)])
        content['home']['log'].insert(0, OrderedDict([
            ('date', args.date), ('body', body), ('link', link),
        ]))
        save(CONTENT, content)
        print(f'logged   homepage entry linking to {href}')

    print(f'\nnext: edit {md.relative_to(ROOT)}, then commit & push.')


if __name__ == '__main__':
    main()
