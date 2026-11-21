// Independent check of the agent's ML-DSA-65 seals with liboqs (Open Quantum Safe),
// a different implementation from the one that signs (@noble/post-quantum).
//   verify_liboqs <public-key.hex> <record.bin> <signature.bin>
// Exit 0 and "valid" if liboqs accepts the signature.
#include <oqs/oqs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char *slurp(const char *path, size_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    rewind(f);
    unsigned char *buf = malloc((size_t)n + 1);
    if (fread(buf, 1, (size_t)n, f) != (size_t)n) { perror("read"); exit(2); }
    fclose(f);
    *len = (size_t)n;
    return buf;
}

int main(int argc, char **argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: %s <public-key.hex> <record.bin> <signature.bin>\n", argv[0]);
        return 2;
    }
    size_t hexlen, mlen, slen;
    unsigned char *hex = slurp(argv[1], &hexlen);
    while (hexlen && (hex[hexlen - 1] == '\n' || hex[hexlen - 1] == '\r')) hexlen--;
    size_t pklen = hexlen / 2;
    unsigned char *pk = malloc(pklen);
    for (size_t i = 0; i < pklen; i++) sscanf((const char *)hex + 2 * i, "%2hhx", &pk[i]);
    unsigned char *msg = slurp(argv[2], &mlen);
    unsigned char *sig = slurp(argv[3], &slen);

    OQS_SIG *s = OQS_SIG_new(OQS_SIG_alg_ml_dsa_65);
    if (!s) { fprintf(stderr, "ML-DSA-65 not enabled in this liboqs\n"); return 2; }
    if (pklen != s->length_public_key || slen != s->length_signature) {
        fprintf(stderr, "size mismatch: pk %zu/%zu sig %zu/%zu\n", pklen, s->length_public_key, slen, s->length_signature);
        return 1;
    }
    OQS_STATUS rc = OQS_SIG_verify(s, msg, mlen, sig, slen, pk);
    printf("%s (liboqs %s, %s, record %zu bytes)\n", rc == OQS_SUCCESS ? "valid" : "INVALID", OQS_VERSION_TEXT, s->method_name, mlen);
    OQS_SIG_free(s);
    return rc == OQS_SUCCESS ? 0 : 1;
}
