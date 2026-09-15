#!/usr/bin/env bash
#
# Start or stop a local single-node MongoDB REPLICA SET for the integration
# tests.
#
# A replica set, not a standalone mongod: the wallet's atomicity relies on
# multi-document transactions, and standalone MongoDB does not support them.
# A standalone server will fail these tests with "Transaction numbers are only
# allowed on a replica set member or mongos", which looks like a bug in the
# wallet and is not one.
#
#   ./scripts/test-db.sh up     # start on :27018 (won't clash with a local :27017)
#   ./scripts/test-db.sh down   # stop and remove
#   ./scripts/test-db.sh uri    # print the URI to export
#
set -euo pipefail

NAME="${MONGO_TEST_CONTAINER:-mini-wallet-test-db}"
PORT="${MONGO_TEST_PORT:-27018}"
IMAGE="${MONGO_TEST_IMAGE:-mongo:8}"
URI="mongodb://127.0.0.1:${PORT}/mini_wallet_test?replicaSet=rs0"

need_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is not installed. Either install it, or point the tests at" >&2
    echo "your own replica set:  export TEST_MONGO_URI=mongodb://.../db?replicaSet=rs0" >&2
    exit 1
  fi
}

case "${1:-up}" in
  up)
    need_docker
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
      echo "Restarted existing container '$NAME'."
    else
      docker run -d --name "$NAME" -p "${PORT}:27017" \
        "$IMAGE" --replSet rs0 --bind_ip_all >/dev/null
      echo "Started '$NAME' on port ${PORT}."
    fi

    printf 'Waiting for mongod'
    for i in $(seq 1 45); do
      if docker exec "$NAME" mongosh --quiet --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then
        echo " ok"; break
      fi
      [ "$i" = "45" ] && { echo; echo "mongod never came up:"; docker logs "$NAME"; exit 1; }
      printf '.'; sleep 2
    done

    # Idempotent: re-initiating an already-initiated set is a harmless error.
    docker exec "$NAME" mongosh --quiet --eval \
      'try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}) } catch (e) { }' >/dev/null 2>&1 || true

    printf 'Waiting for PRIMARY'
    for i in $(seq 1 45); do
      if docker exec "$NAME" mongosh --quiet --eval 'db.hello().isWritablePrimary' 2>/dev/null | grep -q true; then
        echo " ok"; break
      fi
      [ "$i" = "45" ] && { echo; echo "never became primary:"; docker logs "$NAME"; exit 1; }
      printf '.'; sleep 2
    done

    echo
    echo "Ready. Run the integration tests with:"
    echo
    echo "  TEST_MONGO_URI='${URI}' REQUIRE_TEST_DB=true npm run test:integration"
    echo
    ;;

  down)
    need_docker
    docker rm -f "$NAME" >/dev/null 2>&1 && echo "Removed '$NAME'." || echo "Nothing to remove."
    ;;

  uri)
    echo "$URI"
    ;;

  *)
    echo "usage: $0 {up|down|uri}" >&2
    exit 1
    ;;
esac
