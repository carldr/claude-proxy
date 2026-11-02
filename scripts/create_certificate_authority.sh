#!/bin/sh
# Makes the claude-proxy certificate authority and the api.anthropic.com certificate that the proxy uses to decrypt Claude Code traffic.
# Usage: sh scripts/create_certificate_authority.sh <directory>
# The certificate authority can sign only api.anthropic.com. It has a name constraint, so a stolen key cannot impersonate another site.
# The script refuses to replace an existing certificate authority, because every machine that trusts it would need the new one.
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: sh $0 <directory>" >&2
  exit 2
fi
claude_proxy_directory=$1

if [ -e "$claude_proxy_directory/certificate_authority.pem" ] || [ -e "$claude_proxy_directory/certificate_authority-key.pem" ]; then
  echo "A certificate authority already exists in $claude_proxy_directory. Delete certificate_authority*.pem and api.anthropic.com*.pem there to make a new one." >&2
  exit 1
fi

mkdir -p "$claude_proxy_directory"
# Every file starts private. The script makes the two certificates readable at the end.
umask 077
work_directory=$(mktemp -d "$claude_proxy_directory/.create_certificate_authority.XXXXXX")
trap 'rm -rf "$work_directory"' EXIT

# Configuration files work with both OpenSSL and LibreSSL. The -addext option does not work with every LibreSSL version.
cat > "$work_directory/certificate_authority.cnf" <<'CONFIG'
[req]
distinguished_name = distinguished_name
prompt = no
x509_extensions = certificate_authority_extensions
[distinguished_name]
CN = claude-proxy certificate authority for api.anthropic.com
[certificate_authority_extensions]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
nameConstraints = critical,permitted;DNS:api.anthropic.com
subjectKeyIdentifier = hash
CONFIG

cat > "$work_directory/api.anthropic.com.cnf" <<'CONFIG'
subjectAltName = DNS:api.anthropic.com
extendedKeyUsage = serverAuth
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
CONFIG

openssl ecparam -name prime256v1 -genkey -noout -out "$work_directory/certificate_authority-key.pem"
openssl req -x509 -new -days 3650 -config "$work_directory/certificate_authority.cnf" \
  -key "$work_directory/certificate_authority-key.pem" -out "$work_directory/certificate_authority.pem"

openssl ecparam -name prime256v1 -genkey -noout -out "$work_directory/api.anthropic.com-key.pem"
openssl req -new -subj "/CN=api.anthropic.com" -key "$work_directory/api.anthropic.com-key.pem" -out "$work_directory/api.anthropic.com.csr"
openssl x509 -req -days 3650 -in "$work_directory/api.anthropic.com.csr" \
  -CA "$work_directory/certificate_authority.pem" -CAkey "$work_directory/certificate_authority-key.pem" \
  -CAcreateserial -CAserial "$work_directory/certificate_authority.srl" \
  -extfile "$work_directory/api.anthropic.com.cnf" -out "$work_directory/api.anthropic.com.pem"

chmod 644 "$work_directory/certificate_authority.pem" "$work_directory/api.anthropic.com.pem"
for file_name in certificate_authority.pem certificate_authority-key.pem api.anthropic.com.pem api.anthropic.com-key.pem; do
  mv "$work_directory/$file_name" "$claude_proxy_directory/$file_name"
done

echo "Made the certificate authority in $claude_proxy_directory."
echo "Each machine that runs Claude Code trusts $claude_proxy_directory/certificate_authority.pem, or downloads it from /_proxy/certificate_authority.pem."
