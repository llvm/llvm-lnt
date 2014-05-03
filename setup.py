import lnt
import os

from setuptools import setup, find_packages

# setuptools expects to be invoked from within the directory of setup.py, but it
# is nice to allow:
#   python path/to/setup.py install
# to work (for scripts, etc.)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

setup(
    name = "LNT",
    version = lnt.__version__,

    author = lnt.__author__,
    author_email = lnt.__email__,
    url = 'http://llvm.org',
    license = 'BSD',

    description = "LLVM Nightly Test Infrastructure",
    keywords = 'web testing performance development llvm',
    long_description = """\
*LNT*
+++++

About
=====

*LNT* is an infrastructure for performance testing. The software itself consists
of two main parts, a web application for accessing and visualizing performance
data, and command line utilities to allow users to generate and submit test
results to the server.

The package was originally written for use in testing LLVM compiler
technologies, but is designed to be usable for the performance testing of any
software.


Documentation
=============

The official *LNT* documentation is available online at:
  http://llvm.org/docs/lnt


Source
======

The *LNT* source is available in the LLVM SVN repository:
http://llvm.org/svn/llvm-project/lnt/trunk
""",

    classifiers=[
        'Development Status :: 4 - Beta',
        'Environment :: Web Environment',
        'Intended Audience :: Developers',
        ('License :: OSI Approved :: '
         'University of Illinois/NCSA Open Source License'),
        'Natural Language :: English',
        'Operating System :: OS Independent',
        'Programming Language :: Python',
        'Topic :: Software Development :: Quality Assurance',
        'Topic :: Software Development :: Testing',
        ],

    zip_safe = False,

    # Additional resource extensions we use.
    package_data = {'lnt.server.ui': ['static/*.ico',
                                      'static/*.js',
                                      'static/*.css',
                                      'static/*.svg',
                                      'static/bootstrap/css/*.css',
                                      'static/bootstrap/js/*.js',
                                      'static/bootstrap/img/*.png',
                                      'static/flot/*.min.js',
                                      'static/jquery/**/*.min.js',
                                      'templates/*.html',
                                      'templates/reporting/*.html',
                                      'templates/reporting/*.txt'],
                    'lnt.server.db': ['migrations/*.py'] },

    packages = find_packages(),

    test_suite = 'tests.test_all',

    entry_points = {
        'console_scripts': [
            'lnt = lnt.lnttool:main',
            ],
        },
    install_requires=['SQLAlchemy', 'Flask', 'SciPy'],
)
