#!/bin/sh
# Builds the Apple Intelligence helper (native/apple-ai) into native/apple-ai/bin/gatherer-ai.
# Needs a Mac with Xcode 26 or later. Elsewhere it does nothing, and the app falls back to
# Claude (if a key is set) or local summaries.
set -e
cd "$(dirname "$0")/../native/apple-ai"
if [ "$(uname)" != "Darwin" ]; then echo "build-apple-ai: not a Mac, skipping"; exit 0; fi
mkdir -p bin
# Universal so the universal/MAS build can lipo-merge cleanly; Intel Macs just report "unavailable".
if swift build -c release --arch arm64 --arch x86_64; then
  cp "$(swift build -c release --arch arm64 --arch x86_64 --show-bin-path)/gatherer-ai" bin/gatherer-ai
else
  echo "build-apple-ai: universal build failed, building for this Mac only"
  swift build -c release
  cp .build/release/gatherer-ai bin/gatherer-ai
fi
echo "build-apple-ai: built $(pwd)/bin/gatherer-ai"
