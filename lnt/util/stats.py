import math

def mean(l):
    return sum(l)/len(l)

def median(l):
    l = list(l)
    l.sort()
    N = len(l)
    return (l[(N-1)//2] + l[N//2])*.5

def median_absolute_deviation(l, med = None):
    if med is None:
        med = median(l)
    return median([abs(x - med) for x in l])

def standard_deviation(l):
    m = mean(l)
    means_sqrd = sum([(v - m)**2 for v in l]) / len(l)
    rms = math.sqrt(means_sqrd)
    return rms

def mannwhitneyu(a, b, sigLevel = .05):
    """
    Determine if sample a and b are the same at given significance level,
    raises ImportError if SciPy is not installed on server and sample size is
    too large.
    """
    if len(a) <= 20 and len(b) <= 20:
        return mannwhitneyu_small(a, b, sigLevel)
    else:
        try:
            from scipy.stats import mannwhitneyu as mannwhitneyu_large
            return mannwhitneyu_large(a, b, False) >= sigLevel
        except ValueError:
            return True

def mannwhitneyu_small(a, b, sigLevel):
    """
    Determine if sample a and b are the same.
    Sample size must be less than 20.
    """
    assert len(a) <= 20, "Sample size must be less than 20."
    assert len(b) <= 20, "Sample size must be less than 20."

    if not sigLevel in SIGN_TABLES:
        raise ValueError("Do not have according significance table.")

    # Calculate U value for sample groups using method described on Wikipedia.
    flip = len(a) > len(b)
    x = a if not flip else b
    y = b if not flip else a

    Ux = 0.
    for xe in x:
        for ye in y:
            if xe < ye:
                Ux += 1
            elif xe == ye:
                Ux += .5
    Uy = len(a) * len(b) - Ux
    Ua = Ux if not flip else Uy
    Ub = Uy if not flip else Ux

    U = abs(Ua - Ub)

    same = U <= SIGN_TABLES[sigLevel][len(a) - 1][len(b) - 1]
    return same

# Table for .05 significance level.
TABLE_0_05 = [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2],
        [0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8],
        [0, 0, 0, 0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 11, 12, 13, 13],
        [0, 0, 0, 1, 2, 3, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 17, 18, 19, 20],
        [0, 0, 1, 2, 3, 5, 6, 8, 10, 11, 13, 14, 16, 17, 19, 21, 22, 24, 25, 27],
        [0, 0, 1, 3, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34],
        [0, 0, 2, 4, 6, 8, 10, 13, 15, 17, 19, 22, 24, 26, 29, 31, 34, 36, 38, 41],
        [0, 0, 2, 4, 7, 10, 12, 15, 17, 20, 23, 26, 28, 31, 34, 37, 39, 42, 45, 48],
        [0, 0, 3, 5, 8, 11, 14, 17, 20, 23, 26, 29, 33, 36, 39, 42, 45, 48, 52, 55],
        [0, 0, 3, 6, 9, 13, 16, 19, 23, 26, 30, 33, 37, 40, 44, 47, 51, 55, 58, 62],
        [0, 1, 4, 7, 11, 14, 18, 22, 26, 29, 33, 37, 41, 45, 49, 53, 57, 61, 65, 69],
        [0, 1, 4, 8, 12, 16, 20, 24, 28, 33, 37, 41, 45, 50, 54, 59, 63, 67, 72, 76],
        [0, 1, 5, 9, 13, 17, 22, 26, 31, 36, 40, 45, 50, 55, 59, 64, 67, 74, 78, 83],
        [0, 1, 5, 10, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59, 64, 70, 75, 80, 85, 90],
        [0, 1, 6, 11, 15, 21, 26, 31, 37, 42, 47, 53, 59, 64, 70, 75, 81, 86, 92, 98],
        [0, 2, 6, 11, 17, 22, 28, 34, 39, 45, 51, 57, 63, 67, 75, 81, 87, 93, 99, 105],
        [0, 2, 7, 12, 18, 24, 30, 36, 42, 48, 55, 61, 67, 74, 80, 86, 93, 99, 106, 112],
        [0, 2, 7, 13, 19, 25, 32, 38, 45, 52, 58, 65, 72, 78, 85, 92, 99, 106, 113, 119],
        [0, 2, 8, 13, 20, 27, 34, 41, 48, 55, 62, 69, 76, 83, 90, 98, 105, 112, 119, 127]
        ]

# Table for .01 significance level.
TABLE_0_01 = [
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3],
        [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 8],
        [0, 0, 0, 0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 7, 8, 9, 10, 11, 12, 13],
        [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 15, 16, 17, 18],
        [0, 0, 0, 0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 24],
        [0, 0, 0, 1, 2, 4, 6, 7, 9, 11, 13, 15, 17, 18, 20, 22, 24, 26, 28, 30],
        [0, 0, 0, 1, 3, 5, 7, 9, 11, 13, 16, 18, 20, 22, 24, 27, 29, 31, 33, 36],
        [0, 0, 0, 2, 4, 6, 9, 11, 13, 16, 18, 21, 24, 26, 29, 31, 34, 37, 39, 42],
        [0, 0, 0, 2, 5, 7, 10, 13, 16, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 46],
        [0, 0, 1, 3, 6, 9, 12, 15, 18, 21, 24, 27, 31, 34, 37, 41, 44, 47, 51, 54],
        [0, 0, 1, 3, 7, 10, 13, 17, 20, 24, 27, 31, 34, 38, 42, 45, 49, 53, 56, 60],
        [0, 0, 1, 4, 7, 11, 15, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58, 63, 67],
        [0, 0, 2, 5, 8, 12, 16, 20, 24, 29, 33, 37, 42, 46, 51, 55, 60, 64, 69, 73],
        [0, 0, 2, 5, 9, 13, 18, 22, 27, 31, 36, 41, 45, 50, 55, 60, 65, 70, 74, 79],
        [0, 0, 2, 6, 10, 15, 19, 24, 29, 34, 39, 44, 49, 54, 60, 65, 70, 75, 81, 86],
        [0, 0, 2, 6, 11, 16, 21, 26, 31, 37, 42, 47, 53, 58, 64, 70, 75, 81, 87, 92],
        [0, 0, 3, 7, 12, 17, 22, 28, 33, 39, 45, 51, 56, 63, 69, 74, 81, 87, 93, 99],
        [0, 0, 3, 8, 13, 18, 24, 30, 36, 42, 46, 54, 60, 67, 73, 79, 86, 92, 99, 105]
        ]

SIGN_TABLES = {.05: TABLE_0_05, .01: TABLE_0_01}
