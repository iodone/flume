#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
./node_modules/.bin/tsc --noEmit
npm test
