#!/bin/sh
# Creates a self-signed certificate in ./certs for first start or a lab.
# Use a certificate from your internal CA for real deployments.
set -eu
NAME="${1:-failover.internal}"
DIR="$(dirname "$0")/certs"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:3072 -nodes -days 825 \
  -keyout "$DIR/tls.key" -out "$DIR/tls.crt" \
  -subj "/CN=$NAME" -addext "subjectAltName=DNS:$NAME"
chmod 600 "$DIR/tls.key"
echo "Wrote $DIR/tls.crt and $DIR/tls.key for $NAME"
