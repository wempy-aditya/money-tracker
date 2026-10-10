#!/usr/bin/env bash
# Smoke test against the running dev server (port 5000), mirroring real frontend calls.
set -u
BASE="http://127.0.0.1:5000"
U="smoke-user"
pass=0; fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  PASS  %-52s %s\n' "$label" "$actual"; pass=$((pass+1))
  else
    printf '  FAIL  %-52s got %s want %s\n' "$label" "$actual" "$expected"; fail=$((fail+1))
  fi
}

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== pages =="
for p in /wallet /home /transactions /budget /goals; do
  check "GET $p" 200 "$(code "$BASE$p")"
done

echo "== wallets flow =="
WALLET=$(curl -s -X POST "$BASE/api/wallets" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke BCA","balance":5000000}')
WID=$(printf '%s' "$WALLET" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
check "POST /api/wallets returns id" "yes" "$([ -n "$WID" ] && echo yes || echo no)"

curl -s -X PUT "$BASE/api/wallets/$WID" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke BCA","balance":5000000,"frozen":500000}' > /dev/null
FROZEN=$(curl -s "$BASE/api/wallets" | python3 -c "
import json,sys
ws=json.load(sys.stdin)
print(next((w['frozen'] for w in ws if w['id']=='$WID'), 'missing'))")
check "PUT /api/wallets sets frozen" 500000 "$FROZEN"

echo "== transactions flow =="
T1=$(curl -s -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"date\":\"2026-10-01\",\"amount\":9000000,\"type\":\"income\",\"walletId\":\"$WID\",\"category\":\"Gaji\",\"subcategory\":\"Bulanan\",\"description\":\"smoke\"}")
check "POST income" 201 "$(code -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' -d "{\"userId\":\"$U\",\"date\":\"2026-10-02\",\"amount\":750000,\"type\":\"expense\",\"walletId\":\"$WID\",\"category\":\"Makan\",\"subcategory\":\"Belanja\"}" )"

curl -s -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"date\":\"2026-10-05\",\"amount\":125000,\"type\":\"expense\",\"walletId\":\"$WID\",\"category\":\"Transport\",\"subcategory\":\"Bensin\"}" > /dev/null

BAL=$(curl -s "$BASE/api/wallets" | python3 -c "
import json,sys
ws=json.load(sys.stdin)
print(next(w['balance'] for w in ws if w['id']=='$WID'))")
# 5_000_000 + 9_000_000 - 750_000 - 125_000 = 13_125_000
check "wallet balance after income/expenses" 13125000 "$BAL"

check "POST expense beyond balance" 400 "$(code -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' -d "{\"userId\":\"$U\",\"date\":\"2026-10-06\",\"amount\":999999999,\"type\":\"expense\",\"walletId\":\"$WID\"}" )"
check "POST missing fields" 400 "$(code -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' -d '{"userId":"x"}')"
check "POST unknown wallet" 404 "$(code -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' -d "{\"userId\":\"$U\",\"date\":\"2026-10-07\",\"amount\":1000,\"type\":\"expense\",\"walletId\":\"nope\"}" )"

MONTH_TOTAL=$(curl -s "$BASE/api/transactions/$U/2026-10" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "GET transactions for 2026-10" 3 "$MONTH_TOTAL"

echo "== budgeting flow =="
curl -s -X POST "$BASE/api/budgeting" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"month\":\"2026-10\",\"categories\":[{\"name\":\"Makan\",\"total\":2000000,\"subcategories\":[{\"name\":\"Belanja\",\"amount\":2000000}]}]}" > /dev/null
# The expense happened before this budget existed, so `used` stays 0. Budget
# usage is only incremented for transactions created while a budget is present.
USED=$(curl -s "$BASE/api/budgeting/$U/2026-10" | python3 -c "
import json,sys
b=json.load(sys.stdin)
print(b['categories'][0]['subcategories'][0].get('used',0))")
check "budget used is 0 (budget created after expense)" 0 "$USED"

curl -s -X POST "$BASE/api/transactions" -H 'Content-Type: application/json' \
  -d "{\"userId\":\"$U\",\"date\":\"2026-10-08\",\"amount\":300000,\"type\":\"expense\",\"walletId\":\"$WID\",\"category\":\"Makan\",\"subcategory\":\"Belanja\"}" > /dev/null
USED2=$(curl -s "$BASE/api/budgeting/$U/2026-10" | python3 -c "
import json,sys
b=json.load(sys.stdin)
print(b['categories'][0]['subcategories'][0].get('used',0))")
check "budget used after expense with budget present" 300000 "$USED2"
check "GET missing budget" 404 "$(code "$BASE/api/budgeting/$U/1999-01")"

# Totals below include the 300_000 expense added in the budgeting section:
# expenses = 750_000 + 125_000 + 300_000 = 1_175_000
echo "== analytics flow =="
IE=$(curl -s "$BASE/api/analytics/income-expense/$U/2026-10" | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f\"{d['totalIncome']}/{d['totalExpense']}\")")
check "income-expense 2026-10" "9000000/1175000" "$IE"

BVA=$(curl -s "$BASE/api/analytics/budget-vs-actual/$U/2026-10" | python3 -c "
import json,sys
rows=json.load(sys.stdin)
r=next(x for x in rows if x['subcategory']=='Belanja')
print(f\"{r['budget']}/{r['actual']}/{r['difference']}\")")
check "budget-vs-actual Belanja" "2000000/1050000/950000" "$BVA"

EBC=$(curl -s "$BASE/api/analytics/expense-by-category/$U/2026-10" | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f\"{d.get('Makan')}/{d.get('Transport')}\")")
check "expense-by-category" "1050000/125000" "$EBC"

TREND=$(curl -s "$BASE/api/analytics/financial-trend/$U" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
check "financial-trend months" 6 "$TREND"

echo "== goals flow =="
G=$(curl -s -X POST "$BASE/api/goals" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Goal","targetAmount":10000000,"currentAmount":100000,"targetDate":"2026-12-31"}')
GID=$(printf '%s' "$G" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)
check "POST /api/goals" 201 "$(code -X POST "$BASE/api/goals" -H 'Content-Type: application/json' -d '{"name":"Smoke Goal 2","targetAmount":5000000,"currentAmount":0,"targetDate":"2026-12-31"}')"
check "POST goal missing fields" 400 "$(code -X POST "$BASE/api/goals" -H 'Content-Type: application/json' -d '{"name":"no amount"}')"
check "GET goal detail" 200 "$(code "$BASE/api/goals/$GID")"
check "DELETE goal" 200 "$(code -X DELETE "$BASE/api/goals/$GID")"

echo "== export flow (double-prefix bug preserved) =="
check "export transactions csv" 200 "$(code "$BASE/export/export/$U/2026-10/csv")"
check "export transactions json" 200 "$(code "$BASE/export/export/$U/2026-10/json")"
check "export transactions xlsx" 200 "$(code "$BASE/export/export/$U/2026-10/xlsx")"
check "export budget csv" 200 "$(code "$BASE/export/export-budget/$U/2026-10/csv")"
check "export invalid format" 400 "$(code "$BASE/export/export/$U/2026-10/docx")"
check "frontend-style path still 404" 404 "$(code "$BASE/export/$U/2026-10/csv")"

echo
echo "  passed: $pass   failed: $fail"
[ "$fail" -eq 0 ]