"""Minimal GGUF metadata reader: dump architecture keys relevant to KV-cache math."""
import struct, sys, json

def rd(f, fmt):
    n = struct.calcsize(fmt)
    b = f.read(n)
    if len(b) < n:
        raise EOFError
    return struct.unpack(fmt, b)

T_U8,T_I8,T_U16,T_I16,T_U32,T_I32,T_F32,T_BOOL,T_STR,T_ARR,T_U64,T_I64,T_F64 = range(13)

def read_str(f):
    (n,) = rd(f, '<Q')
    return f.read(n).decode('utf-8', 'replace')

def read_val(f, t):
    if t == T_U8:  return rd(f,'<B')[0]
    if t == T_I8:  return rd(f,'<b')[0]
    if t == T_U16: return rd(f,'<H')[0]
    if t == T_I16: return rd(f,'<h')[0]
    if t == T_U32: return rd(f,'<I')[0]
    if t == T_I32: return rd(f,'<i')[0]
    if t == T_F32: return round(rd(f,'<f')[0], 6)
    if t == T_BOOL:return bool(rd(f,'<B')[0])
    if t == T_STR: return read_str(f)
    if t == T_U64: return rd(f,'<Q')[0]
    if t == T_I64: return rd(f,'<q')[0]
    if t == T_F64: return rd(f,'<d')[0]
    if t == T_ARR:
        et, = rd(f,'<I')
        n,  = rd(f,'<Q')
        if n > 100000:            # tokenizer arrays are huge -> skip payload
            if et == T_STR:
                for _ in range(n): read_str(f)
                return f'<{n} strings>'
            sizes = {T_U8:1,T_I8:1,T_U16:2,T_I16:2,T_U32:4,T_I32:4,T_F32:4,T_BOOL:1,T_U64:8,T_I64:8,T_F64:8}
            f.seek(sizes.get(et,4)*n, 1)
            return f'<{n} values>'
        return [read_val(f, et) for _ in range(n)]
    raise ValueError('bad type %d' % t)

def parse(path):
    with open(path,'rb') as f:
        magic, = rd(f,'<I')
        if magic != 0x46554747:
            raise ValueError('not a GGUF: %s' % path)
        ver, = rd(f,'<I')
        n_tensors, = rd(f,'<Q')
        n_kv, = rd(f,'<Q')
        meta = {}
        for _ in range(n_kv):
            k = read_str(f)
            t, = rd(f,'<I')
            meta[k] = read_val(f, t)
        return {'version':ver,'n_tensors':n_tensors,'meta':meta}

if __name__ == '__main__':
    for p in sys.argv[1:]:
        try:
            r = parse(p)
        except Exception as e:
            print(json.dumps({'file':p,'error':str(e)}, ensure_ascii=False)); continue
        m = r['meta']
        arch = m.get('general.architecture','?')
        keys = [k for k in m if any(s in k for s in (
            'block_count','head_count','key_length','value_length','embedding_length',
            'context_length','full_attention_interval','ssm.','rope.dimension','file_type',
            'parameter_count','expert'))]
        out = {'file': p, 'version': r['version'], 'arch': arch, 'n_tensors': r['n_tensors']}
        for k in sorted(keys):
            out[k] = m[k]
        print(json.dumps(out, ensure_ascii=False, indent=1))
