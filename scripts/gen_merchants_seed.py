# Generates supabase/seed_merchants.sql from the Excel file with the Excel's columns and values unchanged.
# Only the date text ("27 Sep 2026") is written in ISO form so Postgres stores it as a date.
import sys, openpyxl, datetime as dt
ws = openpyxl.load_workbook(sys.argv[1]).active
rows = list(ws.iter_rows(values_only=True)); h = list(rows[0])
DATES = {"last_settlement_date", "hold_since", "expected_settlement_date"}
def q(col, v):
    if v is None: return "null"
    if col in DATES: return "'" + dt.datetime.strptime(v, "%d %b %Y").date().isoformat() + "'"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"
vals = ["(" + ",".join(q(c, v) for c, v in zip(h, r)) + ")" for r in rows[1:] if r[0]]
print("-- Generated from Merchants_P1.xlsx: same columns, same values.")
print(f"insert into public.merchants ({','.join(h)}) values")
print(",\n".join(vals) + "\non conflict (merchant_id) do nothing;")
