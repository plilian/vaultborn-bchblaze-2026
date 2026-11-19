#!/usr/bin/env sh
# Consistent copy of the Mainnet database. Run it from cron (for example hourly) on the game server and move the
# result off the machine. The database holds no private keys; the key files are backed up separately, once, offline.
#   sh infrastructure/mainnet/backup.sh /opt/vaultborn/var/mainnet/vaultborn.sqlite /var/backups/vaultborn
set -eu
SOURCE="${1:?database file}"
TARGET="${2:?backup directory}"
mkdir -p "$TARGET"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# VACUUM INTO writes a complete, consistent copy while the game keeps running.
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});db.exec('VACUUM INTO \\''+process.argv[2].replace(/'/g,\"''\")+'\\'');db.close();" "$SOURCE" "$TARGET/vaultborn-$STAMP.sqlite"
gzip "$TARGET/vaultborn-$STAMP.sqlite"
# Keep fourteen days.
find "$TARGET" -name 'vaultborn-*.sqlite.gz' -mtime +14 -delete
echo "$TARGET/vaultborn-$STAMP.sqlite.gz"
