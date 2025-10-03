# RUN: lnt convert --to=json %S/Inputs/test.plist | filecheck %s
# RUN: lnt convert --to=json < %S/Inputs/test.plist | filecheck %s

# CHECK: {"a": 1}
