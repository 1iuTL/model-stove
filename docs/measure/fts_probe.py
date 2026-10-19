import sqlite3
c = sqlite3.connect(':memory:')
c.execute("create virtual table t using fts5(x, tokenize='trigram')")
docs = [
    '上下文窗口是易失的缓存,不是持久化存储',
    'KV cache quantization halves memory usage',
    '线性注意力层不随上下文增长 KV',
]
for d in docs:
    c.execute("insert into t values (?)", (d,))
results = []
for q in ['持久', '缓存', '持久化', '线性注意力', 'quantization']:
    fts = len(c.execute("select x from t where t match ?", (q,)).fetchall())
    like = len(c.execute("select x from t where x like ?", ('%' + q + '%',)).fetchall())
    results.append((q, len(q), fts, like))
with open(r'C:\deepseek harness\_ctx_audit\fts_result.txt', 'w', encoding='utf-8') as f:
    f.write('query | len | FTS-MATCH | LIKE\n')
    for q, n, fts, like in results:
        f.write(f'{q} | {n} | {fts} | {like}\n')
print('written')
