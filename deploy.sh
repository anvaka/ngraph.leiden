#!/bin/sh
set -euo pipefail

# Build demo with correct base path for GitHub Pages
rm -rf ./demo/dist
npm run demo:build

cd ./demo/dist
git init
git add .
git commit -m 'push to gh-pages'
## Deploy to gh-pages of this repository
git branch -M main
git remote add origin git@github.com:anvaka/ngraph.leiden.git
git push --force origin main:gh-pages
cd ../
