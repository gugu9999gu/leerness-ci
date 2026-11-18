# Leerness CI

This repository tests public Leerness source snapshots on Windows and Ubuntu. Each snapshot contains new source and test files in `source/` and changes to previously published files in `changes.patch`. The build uses the [public baseline](https://github.com/gugu9999gu/leerness/commit/b5a3c4631353ba0ab7171cfce5b0c60353223ea3), including its user documentation as test input.

On a snapshot branch, run `python ci/prepare.py <public-baseline-checkout> <new-product-directory>` with Python 3.9 or later. The script verifies the assembled code and tests against the snapshot's SHA-256 digest. Run `npm test` from the new product directory.
