from .profile import ProfileImpl
import bz2
import copy
import io
import os
import struct

"""
ProfileV2 is a profile data representation designed to keep the
profile data on-disk as small as possible while still maintaining good
access speed, specifically to avoid having to load the entire file to
discover just the index (functions and top level counters).

The format:
  * Is a binary format consisting of an index and several sections.
  * Consists of only two datatypes:
    * Strings (newline terminated)
    * Positive integers (ULEB encoded)
  * Some sections are expected to be BZ2 compressed.

The sections are:
  Header
      Contains the disassembly format.

  Counter name pool
      Contains a list of strings for the counter names ("cycles" etc).
      In the rest of the file, counters are referred to by an index into
      this list.

  Top level counters
      Contains key/value pairs for the top level (per-file) counters.

  Functions
      For each function, contains the counters for that function, the number
      of instructions and indices into the LineAddresses, LineCounters and
      LineText sections.

  LineAddresses
      A flat list of numbers, addresses are encoded as offsets from the
      previous address. Each Function knows its starting index into this list
      (the first address is an offset from zero) and how many addresses to
      read.

  LineCounters
      A list of floating point values, one for each counter in the counter name
      pool. There are len(counterNamePool) counter values per instruction.

      Like LineAddresses, Functions know their own index into the LineCounter
      table.

      The numbers are floating point numbers that are bitconverted into
      integers.

  LineText
      A list of offsets into the TextPool, which is a simple string pool.
      Again, Functions know their index into the LineText section.

  TextPool
      A simple string pool.

  The LineAddresses and LineCounters sections are designed to hold very
  repetitive data that is very easy to compress. The LineText section allows
  repeated strings to be reused (for example 'add r0, r0, r0').

  The LineAddresses, LineCounters, LineText and TextPool sections are BZ2
  compressed.

  The TextPool section has the ability to be shared across multiple profiles
  to take advantage of inter-run redundancy (the image very rarely changes
  substantially). This pooling ability is not yet implemented but the
  appropriate scaffolding is in place.

  The ProfileV2 format gives a ~3x size improvement over the ProfileV1 (which
  is also compressed) - meaning a ProfileV2 is roughly 1/3 the size of
  ProfileV1. With text pooling, ProfileV2s can be even smaller.

  Not only this, but for the simple task of enumerating the functions in a
  profile we do not need to do any decompression at all.
"""

##############################################################################
# Utility functions


def readNum(fobj):
    """
    Reads a ULEB encoded number from a stream.
    """
    n = 0
    shift = 0
    while True:
        b = bytearray(fobj.read(1))[0]
        n |= (b & 0x7F) << shift
        shift += 7
        if (b & 0x80) == 0:
            return n


def writeNum(fobj, n):
    """
    Write 'n' as a ULEB encoded number to a stream.
    """
    while True:
        b = n & 0x7F
        n >>= 7
        if n != 0:
            b |= 0x80
        fobj.write(bytearray([b]))

        if n == 0:
            break


def readString(fobj):
    """
    Read a string from a stream.
    """
    return fobj.readline()[:-1].decode()


def writeString(fobj, s):
    """
    Write a string to a stream.
    """
    fobj.write(s.encode())
    fobj.write(u'\n'.encode())


def readFloat(fobj):
    """
    Read a floating point number from a stream.
    """
    num = readNum(fobj)
    packed = struct.pack('>l', num)
    f = struct.unpack('>f', packed)[0]
    return f


def writeFloat(fobj, f):
    """
    Write a floating point number to a stream.
    """
    if f == 0.0:
        writeNum(fobj, 0)
        return
    packed = struct.pack('>f', f)
    bits = struct.unpack('>l', packed)[0]
    writeNum(fobj, bits)

##############################################################################
# Abstract section types


class Section(object):
    def writeHeader(self, fobj, offset, size):
        writeNum(fobj, offset)
        writeNum(fobj, size)

    def readHeader(self, fobj):
        self.offset = readNum(fobj)
        self.size = readNum(fobj)

    def write(self, fobj):
        return self.serialize(fobj)

    def read(self, fobj):
        fobj.seek(self.offset + self.start)
        return self.deserialize(fobj)

    def setStart(self, start):
        """
        Set where this section's offset is calculated from.
        """
        self.start = start

    def copy(self):
        return copy.copy(self)


class CompressedSection(Section):
    def read(self, fobj):
        fobj.seek(self.offset + self.start)
        _io = io.BytesIO(bz2.decompress(fobj.read(self.size)))
        return self.deserialize(_io)

    def write(self, fobj):
        _io = io.BytesIO()
        self.serialize(_io)
        fobj.write(bz2.compress(_io.getvalue()))


class MaybePooledSection(Section):
    """
    A section that is normally compressed, but can optionally be
    inside an external file (where this section from multiple
    files are pooled together)
    """
    def __init__(self):
        self.pool_fname = ''

    def readHeader(self, fobj):
        Section.readHeader(self, fobj)
        self.pool_fname = readString(fobj)

    def writeHeader(self, fobj, offset, size):
        Section.writeHeader(self, fobj, offset, size)
        writeString(fobj, self.pool_fname)

    def read(self, fobj):
        if self.pool_fname:
            raise NotImplementedError()

        else:
            _io = io.BytesIO(bz2.decompress(fobj.read(self.size)))
            self.size = len(_io.getvalue())
            return self.deserialize(_io)

    def write(self, fobj):
        _io = io.BytesIO()
        if self.pool_fname:
            raise NotImplementedError()

        else:
            Section.write(self, _io)
            fobj.write(bz2.compress(_io.getvalue()))

##############################################################################
# Concrete section types


class Header(Section):
    def serialize(self, fobj):
        writeString(fobj, self.disassembly_format)

    def deserialize(self, fobj):
        self.disassembly_format = readString(fobj)

    def upgrade(self, impl):
        self.disassembly_format = impl.getDisassemblyFormat()

    def __repr__(self):
        pass


class CounterNamePool(Section):
    """
    Maps counter names to indices. It allows later sections to refer to
    counters by index.
    """
    def serialize(self, fobj):
        n_names = len(self.idx_to_name)
        writeNum(fobj, n_names)
        for i in range(n_names):
            writeString(fobj, self.idx_to_name[i])

    def deserialize(self, fobj):
        self.idx_to_name = {}
        for i in range(readNum(fobj)):
            self.idx_to_name[i] = readString(fobj)
        self.name_to_idx = {v: k
                            for k, v
                            in self.idx_to_name.items()}

    def upgrade(self, impl):
        self.idx_to_name = {}

        keys = list(impl.getTopLevelCounters().keys())
        for f in impl.getFunctions().values():
            keys.extend(f['counters'].keys())
        keys = sorted(set(keys))

        self.idx_to_name = {k: v for k, v in enumerate(keys)}
        self.name_to_idx = {v: k for k, v in enumerate(keys)}


class TopLevelCounters(Section):
    def __init__(self, counter_name_pool):
        self.counter_name_pool = counter_name_pool

    def serialize(self, fobj):
        writeNum(fobj, len(self.counters))
        for k, v in sorted(self.counters.items()):
            writeNum(fobj, self.counter_name_pool.name_to_idx[k])
            writeNum(fobj, int(v))

    def deserialize(self, fobj):
        self.counters = {}
        for i in range(readNum(fobj)):
            k = readNum(fobj)
            v = readNum(fobj)
            self.counters[self.counter_name_pool.idx_to_name[k]] = v

    def upgrade(self, impl):
        self.counters = impl.data['counters'].copy()

    def copy(self, cnp):
        new = copy.copy(self)
        new.counter_name_pool = cnp
        return new


class LineCounters(CompressedSection):
    def __init__(self, impl=None):
        self.impl = impl
        self.function_offsets = {}

    def serialize(self, fobj):
        assert self.impl

        self.function_offsets = {}
        start = fobj.tell()
        for fname, f in sorted(self.impl.getFunctions().items()):
            self.function_offsets[fname] = fobj.tell() - start
            all_counters = sorted(f['counters'].keys())
            for counters, address, text in self.impl.getCodeForFunction(fname):
                for k in all_counters:
                    writeFloat(fobj, counters.get(k, 0))

    def deserialize(self, fobj):
        self.data = fobj.read()

    def upgrade(self, impl):
        self.impl = impl
        self.function_offsets = {}

    def getOffsetFor(self, fname):
        return self.function_offsets[fname]

    def setOffsetFor(self, fname, value):
        self.function_offsets[fname] = value

    def extractForFunction(self, fname, counters):
        offset = self.function_offsets[fname]
        _io = io.BytesIO(self.data)
        _io.seek(offset)
        counters.sort()
        while True:
            c = {}
            for k in counters:
                c[k] = readFloat(_io)
            yield c


class LineAddresses(CompressedSection):
    def __init__(self, impl=None):
        self.impl = impl
        self.function_offsets = {}

    def serialize(self, fobj):
        """
        Addresses are encoded as a delta from the previous address. This allows
        huge compression ratios as the increments (for RISC architectures) will
        usually be constant.
        """
        assert self.impl

        self.function_offsets = {}
        start = fobj.tell()
        for fname in sorted(self.impl.getFunctions()):
            self.function_offsets[fname] = fobj.tell() - start
            prev_address = 0
            for counters, address, text in self.impl.getCodeForFunction(fname):
                # FIXME: Hack around a bug in perf extraction somewhere - if
                # we go off the end of a symbol to a previous symbol,
                # addresses will go backwards!
                writeNum(fobj, max(0, address - prev_address))
                prev_address = address

    def deserialize(self, fobj):
        self.data = fobj.read()

    def upgrade(self, impl):
        self.impl = impl
        self.function_offsets = {}

    def getOffsetFor(self, fname):
        return self.function_offsets[fname]

    def setOffsetFor(self, fname, value):
        self.function_offsets[fname] = value

    def extractForFunction(self, fname):
        offset = self.function_offsets[fname]
        _io = io.BytesIO(self.data)
        _io.seek(offset)
        last_address = 0
        while True:
            address = readNum(_io) + last_address
            last_address = address
            yield address


class LineText(CompressedSection):
    """
    Text lines (like "add r0, r0, r0") can be repeated.

    Instead of just storing the text in raw form, we store pointers into
    a text pool. This allows text to be reused, but also reused between
    different profiles if required (the text pools can be extracted
    into a separate file)
    """
    def __init__(self, text_pool, impl=None):
        CompressedSection.__init__(self)
        self.impl = impl
        self.function_offsets = {}
        self.text_pool = text_pool

    def serialize(self, fobj):
        assert self.impl

        self.function_offsets = {}
        start = fobj.tell()
        for fname in sorted(self.impl.getFunctions()):
            self.function_offsets[fname] = fobj.tell() - start
            for counters, address, text in self.impl.getCodeForFunction(fname):
                writeNum(fobj, self.text_pool.getOrCreate(text))
            writeNum(fobj, 0)  # Write sequence terminator

    def deserialize(self, fobj):
        # FIXME: Make this lazy.
        self.data = fobj.read()

    def upgrade(self, impl):
        self.impl = impl
        self.function_offsets = {}

    def getOffsetFor(self, fname):
        return self.function_offsets[fname]

    def setOffsetFor(self, fname, value):
        self.function_offsets[fname] = value

    def extractForFunction(self, fname):
        offset = self.function_offsets[fname]

        _io = io.BytesIO(self.data)
        _io.seek(offset)
        while True:
            n = readNum(_io)
            yield self.text_pool.getAt(n)

    def copy(self, tp):
        new = copy.copy(self)
        new.text_pool = tp
        return new


class TextPool(MaybePooledSection):
    def __init__(self):
        MaybePooledSection.__init__(self)
        self.offsets = {}
        # Populate data with a single character initially so that zero is
        # never a valid string pool index. LineText relies upon this to use
        # zero as a sentinel.
        self.data = io.BytesIO(u'\n'.encode())
        self.pool_read = False

    def serialize(self, fobj):
        self.data.seek(0)
        fobj.write(self.data.read())

    def deserialize(self, fobj):
        # FIXME: Make this lazy!
        self.data = io.BytesIO(fobj.read(self.size))

    def upgrade(self, impl):
        pass

    def getOrCreate(self, text):
        if self.pool_fname and not self.pool_read:
            assert False
            self.readFromPool()

        if text in self.offsets:
            return self.offsets[text]
        self.offsets[text] = self.data.tell()
        writeString(self.data, text)
        return self.offsets[text]

    def getAt(self, offset):
        self.data.seek(offset, os.SEEK_SET)
        return readString(self.data)

    def copy(self):
        return copy.deepcopy(self)


class Functions(Section):
    def __init__(self, counter_name_pool, line_counters,
                 line_addresses, line_text, impl=None):
        self.counter_name_pool = counter_name_pool
        self.line_counters = line_counters
        self.line_addresses = line_addresses
        self.line_text = line_text
        self.impl = impl

    def serialize(self, fobj):
        writeNum(fobj, len(self.functions))
        for name in sorted(self.functions):
            f = self.functions[name]

            writeString(fobj, name)
            writeNum(fobj, f['length'])
            writeNum(fobj, self.line_counters.getOffsetFor(name))
            writeNum(fobj, self.line_addresses.getOffsetFor(name))
            writeNum(fobj, self.line_text.getOffsetFor(name))

            writeNum(fobj, len(f['counters']))
            for k, v in sorted(f['counters'].items()):
                writeNum(fobj, self.counter_name_pool.name_to_idx[k])
                writeFloat(fobj, v)

    def deserialize(self, fobj):
        self.functions = {}
        for i in range(readNum(fobj)):
            f = {}
            name = readString(fobj)
            f['length'] = readNum(fobj)
            self.line_counters.setOffsetFor(name, readNum(fobj))
            self.line_addresses.setOffsetFor(name, readNum(fobj))
            self.line_text.setOffsetFor(name, readNum(fobj))
            f['counters'] = {}

            for j in range(readNum(fobj)):
                k = self.counter_name_pool.idx_to_name[readNum(fobj)]
                v = readFloat(fobj)
                f['counters'][k] = v

            self.functions[name] = f

    def upgrade(self, impl):
        self.impl = impl
        self.functions = self.impl.getFunctions()

    def getCodeForFunction(self, fname):
        f = self.functions[fname]
        counter_gen = self.line_counters \
            .extractForFunction(fname, list(f['counters'].keys()))
        address_gen = self.line_addresses.extractForFunction(fname)
        text_gen = self.line_text.extractForFunction(fname)
        for n in range(f['length']):
            yield (next(counter_gen), next(address_gen), next(text_gen))

    def copy(self, counter_name_pool, line_counters,
             line_addresses, line_text):
        new = copy.copy(self)
        new.counter_name_pool = counter_name_pool
        new.line_counters = line_counters
        new.line_addresses = line_addresses
        new.line_text = line_text
        return new


class ProfileV2(ProfileImpl):
    @staticmethod
    def checkFile(fn):
        # The first number is the version (2); ULEB encoded this is simply
        # 0x02.
        with open(fn, 'rb') as f:
            return f.read(1) == b'\x02'

    @staticmethod
    def deserialize(fobj):
        p = ProfileV2()

        p.h = Header()
        p.cnp = CounterNamePool()
        p.tlc = TopLevelCounters(p.cnp)
        p.lc = LineCounters(p)
        p.la = LineAddresses(p)
        p.tp = TextPool()
        p.lt = LineText(p.tp, p)
        p.f = Functions(p.cnp, p.lc, p.la, p.lt, p)

        p.sections = [p.h, p.cnp, p.tlc, p.lc, p.la, p.lt, p.tp, p.f]

        version = readNum(fobj)
        assert version == 2

        for section in p.sections:
            section.readHeader(fobj)
        for section in p.sections:
            section.setStart(fobj.tell())
        for section in p.sections:
            section.read(fobj)

        return p

    def serialize(self, fname=None):
        # If we're not writing to a file, emulate a file object instead.
        if fname is None:
            fobj = io.BytesIO()
        else:
            fobj = open(fname, 'wb')

        # Take a copy of all sections. While writing we may change
        # offsets / indices, and we need to ensure we can modify our
        # sections' states without affecting the original object (we may
        # need to read from it while writing! (getCodeForFunction))
        h = self.h.copy()
        cnp = self.cnp.copy()
        tlc = self.tlc.copy(cnp)
        lc = self.lc.copy()
        la = self.la.copy()
        tp = self.tp.copy()
        lt = self.lt.copy(tp)
        f = self.f.copy(cnp, lc, la, lt)
        sections = [h, cnp, tlc, lc, la, lt, tp, f]

        writeNum(fobj, 2)  # Version

        # We need to write all sections first, so we know their offset
        # before we write the header.
        tmpio = io.BytesIO()
        offsets = {}
        sizes = {}
        for section in sections:
            offsets[section] = tmpio.tell()
            section.write(tmpio)
            sizes[section] = tmpio.tell() - offsets[section]

        for section in sections:
            section.writeHeader(fobj, offsets[section], sizes[section])
        fobj.write(tmpio.getvalue())

        if fname is None:
            return fobj.getvalue()

    @staticmethod
    def upgrade(v1impl):
        assert v1impl.getVersion() == 1

        p = ProfileV2()

        p.h = Header()
        p.cnp = CounterNamePool()
        p.tlc = TopLevelCounters(p.cnp)
        p.lc = LineCounters(p)
        p.la = LineAddresses(p)
        p.tp = TextPool()
        p.lt = LineText(p.tp, p)
        p.f = Functions(p.cnp, p.lc, p.la, p.lt, p)

        p.sections = [p.h, p.cnp, p.tlc, p.lc, p.la, p.lt, p.tp, p.f]

        for section in p.sections:
            section.upgrade(v1impl)

        return p

    def getVersion(self):
        return 2

    def getFunctions(self):
        return self.f.functions

    def getTopLevelCounters(self):
        return self.tlc.counters

    def getCodeForFunction(self, fname):
        return self.f.getCodeForFunction(fname)
