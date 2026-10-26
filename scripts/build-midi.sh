#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p output .cache/swift
swiftc -O -module-cache-path .cache/swift bridge/Midi.swift -o output/threadboard-midi -framework CoreMIDI -framework Foundation
echo 'Built output/threadboard-midi'
