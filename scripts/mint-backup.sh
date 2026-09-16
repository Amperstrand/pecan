#!/usr/bin/env bash
# Off-box encrypted backup of EVERY giftcard mint on inr2 (EUR, USD,
# NOK — the pair list lives in scripts/pairs.sh): docker-compose.yml,
# .env (holds CDK_MINTD_MNEMONIC), mint.toml, and a consistent sqlite
# snapshot (live-service safe, .backup API) per mint.
#
#   scripts/mint-backup.sh            # archive to ~/backups/pecan-mint/
#
# The archive is the only thing that can re-issue outstanding giftcard
# ecash after inr2 dies — re-run after keyset rollovers or quarterly.
#
# Encryption: aes-256-cbc + pbkdf2(600k). The passphrase lives in the
# macOS Keychain (service `pecan-mint-backup-passphrase`), generated on
# first run and reused after. Rotate by deleting the Keychain entry and
# re-running — old archives then need their own recorded passphrase, so
# WRITE THE PASSPHRASE DOWN PHYSICALLY as well:
#
#   security find-generic-password -a pecan-mint-backup \
#     -s pecan-mint-backup-passphrase -w
#
# Decrypt an archive:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
#     -in ~/backups/pecan-mint/<archive> -pass pass:'<passphrase>' | tar tz
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/pairs.sh
INR2=root@46.224.104.12
STAMP=$(date +%Y%m%d)
ARCHIVE=pecan-mint-backup-$STAMP.tar.gz.enc
DEST=~/backups/pecan-mint
KEYCHAIN_SERVICE=pecan-mint-backup-passphrase

PASS=$(security find-generic-password -a pecan-mint-backup -s $KEYCHAIN_SERVICE -w 2>/dev/null || true)
if [ -z "$PASS" ]; then
  PASS=$(openssl rand -base64 32)
  security add-generic-password -a pecan-mint-backup -s $KEYCHAIN_SERVICE -w "$PASS"
fi

[ -f "$DEST/$ARCHIVE" ] && { echo "refusing to overwrite $DEST/$ARCHIVE"; exit 1; }

# Stage + snapshot on inr2 via a script file — nested SSH quoting has
# corrupted commands here before (same lesson as rails-audit.sh). The
# body is emitted per-pair from the manifest, so the remote script is
# explicit paths only.
{
  echo 'set -euo pipefail'
  echo 'STAGE=/tmp/mint-backup-stage'
  echo 'rm -rf $STAGE && mkdir -p $STAGE'
  for u in $PAIRS; do
    d=$(pair_field "$u" mint_dir)
    c=$(pair_field "$u" mint_cfg)
    echo "mkdir -p \$STAGE/$u"
    echo "cp $d/docker-compose.yml $d/$c \$STAGE/$u/"
    echo "[ -f $d/.env ] && cp $d/.env \$STAGE/$u/"
    echo "sqlite3 $d/data/cdk-mintd.sqlite \".backup '\$STAGE/$u/cdk-mintd.sqlite'\""
  done
  echo 'tar czf /tmp/mint-backup-tmp.tar.gz -C /tmp mint-backup-stage'
  echo 'chmod 600 /tmp/mint-backup-tmp.tar.gz'
} > /tmp/mint-stage.sh
scp -q /tmp/mint-stage.sh $INR2:/tmp/mint-stage.sh
ssh $INR2 'bash /tmp/mint-stage.sh' </dev/null

# Encrypt on inr2 with the passphrase on stdin only.
ssh $INR2 "openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in /tmp/mint-backup-tmp.tar.gz -out /tmp/$ARCHIVE -pass stdin && rm -f /tmp/mint-backup-tmp.tar.gz /tmp/mint-stage.sh && rm -rf /tmp/mint-backup-stage && chmod 600 /tmp/$ARCHIVE" <<< "$PASS"

mkdir -p $DEST
scp -q $INR2:/tmp/$ARCHIVE "$DEST/$ARCHIVE"
ssh $INR2 "rm -f /tmp/$ARCHIVE" </dev/null
chmod 600 "$DEST/$ARCHIVE"

# Round-trip: prove the fetched archive decrypts with the Keychain passphrase.
# Three entries per pair minimum (compose, mint.toml, sqlite) — a missing
# pair fails here, not at restore time.
entries=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$DEST/$ARCHIVE" -pass stdin <<< "$PASS" | tar tz | grep -c .)
min_entries=$(( $(printf '%s\n' $PAIRS | wc -w) * 3 ))
[ "$entries" -ge "$min_entries" ] || { echo "decrypt verification FAILED ($entries entries, need >= $min_entries — a pair is missing)"; exit 1; }

echo "ok: $DEST/$ARCHIVE ($entries entries, decrypt-verified)"
echo "reminder: passphrase is in the macOS Keychain ($KEYCHAIN_SERVICE) — also record it physically."
