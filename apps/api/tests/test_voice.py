from app.main import evaluate

def test_correct_answer():
    assert evaluate("It's a cow", "cow").correct is True

def test_incorrect_answer():
    assert evaluate("cat", "cow").correct is False

def test_empty_answer():
    assert not evaluate("", "dog").correct
