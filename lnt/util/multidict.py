class multidict:
    def __init__(self, elts=()):
        self.data = {}
        for key, value in elts:
            self[key] = value

    def __contains__(self, item):
        return item in self.data

    def __getitem__(self, item):
        return self.data[item]

    def __setitem__(self, key, value):
        if key in self.data:
            self.data[key].append(value)
        else:
            self.data[key] = [value]

    def items(self):
        return self.data.items()

    def values(self):
        return self.data.values()

    def keys(self):
        return self.data.keys()

    def __len__(self):
        return len(self.data)

    def get(self, key, default=None):
        return self.data.get(key, default)
