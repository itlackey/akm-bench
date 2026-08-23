Your working directory is `/app`. It contains a `docker-compose.yml` file
written against Compose file format v2.

Edit `docker-compose.yml` to upgrade it to Compose file format 3.8. The
upgrade requires changing the version string and removing any service-level
keys that were deprecated or removed in the v3 format.

When you are done, `docker-compose.yml` must still parse as valid YAML, its
`version` field must read `3.8`, and no service may retain a service-level
key that no longer applies in the v3 format.
