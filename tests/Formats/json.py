# RUN: lnt convert --to=json %S/Inputs/test.json | filecheck %s
# RUN: lnt convert --to=json < %S/Inputs/test.json | filecheck %s

# CHECK: {"a": 1}
