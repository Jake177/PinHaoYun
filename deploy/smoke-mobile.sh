#!/bin/sh
set -eu
docker run --detach --name pinhaoyun-mobile-smoke -p 127.0.0.1:3000:3000 -e PH_API_ONLY=true -e APP_ENV=development "$REPOSITORY_URI:$IMAGE_TAG"
trap 'docker logs pinhaoyun-mobile-smoke; docker rm --force pinhaoyun-mobile-smoke >/dev/null' EXIT
attempt=0
until curl --silent --fail http://127.0.0.1:3000/api/mobile/health >/tmp/pinhaoyun-health.json; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then exit 1; fi
  sleep 2
done
python3 -c 'import json; assert json.load(open("/tmp/pinhaoyun-health.json"))["status"] == "ok"'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/user/profile)" = 401
echo 'Container health, API-only routing and unauthenticated rejection passed.'
