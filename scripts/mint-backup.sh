#!/usr/bin/env bash
# Off-box encrypted backup of BOTH giftcard mints (EUR + USD) on inr2:
# docker-compose.yml, .env (holds CDK_MINTD_MNEMONIC), mint.toml, and a
# consistent sqlite snapshot (live-service safe, .backup API) per mint.
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
# corrupted commands here before (same lesson as rails-audit.sh).
cat > /tmp/mint-stage.sh <<'EOF'
set -euo pipefail
STAGE=/tmp/mint-backup-stage
rm -rf $STAGE && mkdir -p $STAGE/eur $STAGE/usd
for side in eur:giftcard-mint usd:giftcard-mint-usd; do
  name=${side%%:*}
  dir=/opt/${side#*:}
  [ "$name" = eur ] && cfg=$dir/mint.toml || cfg=$dir/data/mint.toml
  cp $dir/docker-compose.yml $cfg $STAGE/$name/
  [ -f $dir/.env ] && cp $dir/.env $STAGE/$name/
  sqlite3 $dir/data/cdk-mintd.sqlite ".backup '$STAGE/$name/cdk-mintd.sqlite'"
done
tar czf /tmp/mint-backup-tmp.tar.gz -C /tmp mint-backup-stage
chmod 600 /tmp/mint-backup-tmp.tar.gz
EOF
scp -q /tmp/mint-stage.sh $INR2:/tmp/mint-stage.sh
ssh $INR2 'bash /tmp/mint-stage.sh' </dev/null

# Encrypt on inr2 with the passphrase on stdin only.
ssh $INR2 "openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -in /tmp/mint-backup-tmp.tar.gz -out /tmp/$ARCHIVE -pass stdin && rm -f /tmp/mint-backup-tmp.tar.gz /tmp/mint-stage.sh && rm -rf /tmp/mint-backup-stage && chmod 600 /tmp/$ARCHIVE" <<< "$PASS"

mkdir -p $DEST
scp -q $INR2:/tmp/$ARCHIVE "$DEST/$ARCHIVE"
ssh $INR2 "rm -f /tmp/$ARCHIVE" </dev/null
chmod 600 "$DEST/$ARCHIVE"

# Round-trip: prove the fetched archive decrypts with the Keychain passphrase.
entries=$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in "$DEST/$ARCHIVE" -pass stdin <<< "$PASS" | tar tz | grep -c .)
[ "$entries" -ge 8 ] || { echo "decrypt verification FAILED ($entries entries)"; exit 1; }

echo "ok: $DEST/$ARCHIVE ($entries entries, decrypt-verified)"
echo "reminder: passphrase is in the macOS Keychain ($KEYCHAIN_SERVICE) — also record it physically."
