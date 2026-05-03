from services.projectors.compound_fingerprinter.main import _bits_to_vector


def test_bits_to_vector_zero_bits():
    v = _bits_to_vector([], 8)
    assert v == "[0,0,0,0,0,0,0,0]"


def test_bits_to_vector_some_bits():
    v = _bits_to_vector([0, 3, 7], 8)
    assert v == "[1,0,0,1,0,0,0,1]"


def test_bits_to_vector_clamps_out_of_range():
    # Bits outside [0, n_bits) are silently dropped, not erroring.
    v = _bits_to_vector([-1, 0, 7, 8, 99], 8)
    assert v == "[1,0,0,0,0,0,0,1]"


def test_bits_to_vector_size_matches():
    v = _bits_to_vector([0, 50], 100)
    assert v.count(",") == 99
