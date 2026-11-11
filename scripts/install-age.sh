#!/bin/bash
# Installs age (the backup cipher) on a GitHub runner. From age's own GitHub release first, checked by its sha256:
# twice on 2026-11-11 the runner could not resolve security.ubuntu.com and `apt-get install age` stopped the site's
# deploy. Ubuntu's package is the fallback.
set -u
command -v age >/dev/null && exit 0
V=v1.2.1
SUM=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
T=$(mktemp -d)
if curl -fsSL --retry 3 --retry-all-errors -m 60 -o "$T/age.tgz" "https://github.com/FiloSottile/age/releases/download/$V/age-$V-linux-amd64.tar.gz" &&
  echo "$SUM  $T/age.tgz" | sha256sum -c --quiet - &&
  tar -xzf "$T/age.tgz" -C "$T" && sudo install -m 755 "$T/age/age" /usr/local/bin/age; then
  age --version
  exit 0
fi
echo "age from GitHub failed, trying apt" >&2
sudo apt-get install -y age >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y age >/dev/null; }
