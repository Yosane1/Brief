#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Petit client Airtable partagé par les scripts du projet.

Les appels passent par `curl` : le magasin de certificats de Python est
inutilisable derrière l'inspection TLS de certains postes Windows.
"""
import json
import os
import subprocess
import tempfile
import urllib.parse

TOKEN = os.environ.get(
    "AIRTABLE_TOKEN",
    "patDnefT5sQlQc2L1.7388f732d1cac15a74705c77a61c2d0be78892cb5594d5ee6d0e9d0bf1683b01",
)
BASE_ID = os.environ.get("AIRTABLE_BASE_ID", "appzxFhyARS0LjDFc")
API = "https://api.airtable.com/v0"

# Identifiants stables des tables (voir scripts/setup_airtable.py)
T = {
    "reglages": "tbl0n9LTnbmLWArwu",
    "editions": "tbl3iBc69xGDR5Sg8",
    "articles": "tblBCSPDzwOWv1oMn",
    "clients":  "tbl7g2e6qkj89IApu",
    "push":     "tblD3A0snPC239bgo",
    "journal":  "tblKOTUxKjS6IgOOj",
}


class AirtableError(RuntimeError):
    pass


def call(method, path, payload=None, params=None):
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    cmd = [
        "curl", "-s", "-X", method, url,
        "-H", f"Authorization: Bearer {TOKEN}",
        "-H", "Content-Type: application/json",
    ]
    tmp = None
    if payload is not None:
        tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        json.dump(payload, tmp, ensure_ascii=False)
        tmp.close()
        cmd += ["--data-binary", f"@{tmp.name}"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    finally:
        if tmp:
            os.unlink(tmp.name)
    if out.returncode != 0:
        raise AirtableError(f"curl {out.returncode} sur {method} {path}\n{out.stderr}")
    if not out.stdout.strip():
        return {}
    try:
        res = json.loads(out.stdout)
    except json.JSONDecodeError:
        raise AirtableError(f"Réponse illisible sur {method} {path}\n{out.stdout[:500]}")
    if isinstance(res, dict) and "error" in res:
        raise AirtableError(
            f"{method} {path} → {json.dumps(res['error'], ensure_ascii=False)}"
        )
    return res


def select(table, formula=None, fields=None, sort=None, max_records=None):
    """Récupère tous les enregistrements (pagination incluse)."""
    params, records, offset = {}, [], None
    if formula:
        params["filterByFormula"] = formula
    if fields:
        params["fields[]"] = fields
    if sort:
        for i, (f, d) in enumerate(sort):
            params[f"sort[{i}][field]"] = f
            params[f"sort[{i}][direction]"] = d
    if max_records:
        params["maxRecords"] = max_records
    while True:
        p = dict(params)
        if offset:
            p["offset"] = offset
        res = call("GET", f"/{BASE_ID}/{T.get(table, table)}", params=p)
        records += res.get("records", [])
        offset = res.get("offset")
        if not offset or (max_records and len(records) >= max_records):
            break
    return records


def create(table, rows):
    """Crée des enregistrements par lots de 10. `rows` = liste de dicts fields."""
    made = []
    for i in range(0, len(rows), 10):
        chunk = [{"fields": r} for r in rows[i:i + 10]]
        res = call("POST", f"/{BASE_ID}/{T.get(table, table)}",
                   {"records": chunk, "typecast": True})
        made += res.get("records", [])
    return made


def update(table, rows):
    """Met à jour des enregistrements. `rows` = liste de {id, fields}."""
    done = []
    for i in range(0, len(rows), 10):
        res = call("PATCH", f"/{BASE_ID}/{T.get(table, table)}",
                   {"records": rows[i:i + 10], "typecast": True})
        done += res.get("records", [])
    return done


def delete(table, ids):
    for i in range(0, len(ids), 10):
        call("DELETE", f"/{BASE_ID}/{T.get(table, table)}",
             params={"records[]": ids[i:i + 10]})
    return len(ids)


def esc(value):
    """Échappe une valeur pour une formule Airtable."""
    return str(value).replace("\\", "\\\\").replace("'", "\\'")
