from __future__ import print_function
import lnt
import os
from sys import platform as _platform
import sys
from setuptools import setup, find_packages, Extension

if sys.version_info < (3, 6) and sys.version_info[:2] != (2, 7):
    raise RuntimeError("Python 2.7 or Python 3.6 or higher required.")

cflags = []

if _platform == "darwin":
    os.environ["CC"] = "xcrun --sdk macosx clang"
    os.environ["CXX"] = "xcrun --sdk macosx clang"
    cflags += ['-stdlib=libc++', '-mmacosx-version-min=10.7']

# setuptools expects to be invoked from within the directory of setup.py, but
# it is nice to allow:
#   python path/to/setup.py install
# to work (for scripts, etc.)
os.chdir(os.path.dirname(os.path.abspath(__file__)))

cPerf = Extension('lnt.testing.profile.cPerf',
                  sources=['lnt/testing/profile/cPerf.cpp'],
                  extra_compile_args=['-std=c++11'] + cflags)

if "--server" in sys.argv:
    sys.argv.remove("--server")
    print("Use pip to install requirements.server.txt for a full server install:")
    print("pip install -r ./requirements.server.txt")
    sys.exit(1)


setup(
    name="LNT",
    version=lnt.__version__,

    author=lnt.__author__,
    author_email=lnt.__email__,
    url='http://llvm.org',
    license = 'Apache-2.0 with LLVM exception',

    description="LLVM Nightly Test Infrastructure",
    keywords='web testing performance development llvm',
    long_description="""\
*LNT*
+++++

About
=====

*LNT* is an infrastructure for performance testing. The software itself
consists of two main parts, a web application for accessing and visualizing
performance data, and command line utilities to allow users to generate and
submit test results to the server.

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
        'License :: OSI Approved :: Apache-2.0 with LLVM exception',
        'Natural Language :: English',
        'Operating System :: OS Independent',
        'Programming Language :: Python',
        'Topic :: Software Development :: Quality Assurance',
        'Topic :: Software Development :: Testing',
    ],

    zip_safe=False,

    # Additional resource extensions we use.
    package_data={'lnt.server.ui': ['static/*.ico',
                                    'static/*.js',
                                    'static/*.css',
                                    'static/*.svg',
                                    'static/bootstrap/css/*.css',
                                    'static/bootstrap/js/*.js',
                                    'static/bootstrap/img/*.png',
                                    'static/flot/*.min.js',
                                    'static/d3/*.min.js',
                                    'static/jquery/**/*.min.js',
                                    'templates/*.html',
                                    'templates/reporting/*.html',
                                    'templates/reporting/*.txt'],
                  'lnt.server.db': ['migrations/*.py'],
                  },

    packages=find_packages(),

    test_suite='tests.test_all',

    entry_points={
        'console_scripts': [
            'lnt = lnt.lnttool:main',
        ],
    },
    install_requires=[
        "six",
        "aniso8601==1.2.0",
        "Flask==0.12.2",
        "Flask-RESTful==0.3.4",
        "Jinja2==2.7.2",
        "MarkupSafe==0.23",
        "SQLAlchemy==1.1.11",
        "Werkzeug==0.12.2",
        "itsdangerous==0.24",
        "python-dateutil==2.6.0",
        "python-gnupg==0.3.7",
        "pytz==2016.10",
        "WTForms==2.0.2",
        "Flask-WTF==0.12",
        "typing",
        "click==6.7",
        "pyyaml==3.13",
        "requests",
        "future",
        "lit",
    ],

    ext_modules=[cPerf],

    python_requires='>=2.7, !=3.0.*, !=3.1.*, !=3.2.*, !=3.3.*, !=3.4.*, !=3.5.*',
)
