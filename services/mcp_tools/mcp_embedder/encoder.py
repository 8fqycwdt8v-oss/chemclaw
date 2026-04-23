"""Encoder abstraction.

The encoder is kept behind a protocol so unit tests can supply a fake
encoder without requiring the heavyweight sentence-transformers download.
"""

from __future__ import annotations

from typing import Protocol

import numpy as np


class Encoder(Protocol):
    dim: int
    model_name: str

    def encode(self, texts: list[str], *, normalize: bool) -> list[list[float]]: ...


class BGEM3Encoder:
    """Thin wrapper around sentence-transformers BGE-M3.

    Model is loaded lazily on first use to keep import-time light.
    """

    def __init__(self, model_name: str, device: str):
        self._model_name = model_name
        self._device = device
        self._model = None  # loaded lazily
        self._dim = 1024  # BGE-M3

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return self._model_name

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        # Import inside to avoid heavy import at module load.
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(self._model_name, device=self._device)
        # Some models expose a different dimension; prefer the actual one.
        inferred = self._model.get_sentence_embedding_dimension()
        if inferred and inferred != self._dim:
            self._dim = int(inferred)

    def encode(self, texts: list[str], *, normalize: bool) -> list[list[float]]:
        self._ensure_loaded()
        assert self._model is not None
        # batch_size default is 32; we keep it modest for CPU
        arr = self._model.encode(
            texts,
            batch_size=16,
            show_progress_bar=False,
            normalize_embeddings=normalize,
            convert_to_numpy=True,
        )
        if not isinstance(arr, np.ndarray):
            arr = np.asarray(arr)
        return arr.astype(np.float32).tolist()


class StubEncoder:
    """Deterministic CPU-only encoder for tests and dev without model download.

    Produces hash-derived embeddings: same text always yields the same
    vector. NOT semantic — only useful for wiring tests.
    """

    def __init__(self, dim: int = 1024, model_name: str = "stub-encoder") -> None:
        self._dim = dim
        self._model_name = model_name

    @property
    def dim(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return self._model_name

    def encode(self, texts: list[str], *, normalize: bool) -> list[list[float]]:
        out = []
        for t in texts:
            # Deterministic pseudo-random via hash seeding.
            rng = np.random.default_rng(seed=abs(hash(t)) % (2**32))
            v = rng.standard_normal(self._dim).astype(np.float32)
            if normalize:
                n = float(np.linalg.norm(v))
                if n > 0:
                    v = v / n
            out.append(v.tolist())
        return out
