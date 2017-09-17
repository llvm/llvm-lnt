# Testing text importing.
#
# RUN: echo "foo.exec 10" > input
# RUN: echo "bar.exec 20" >> input
# RUN: echo "foo.hash d7" >> input
# RUN: echo "bar.profile Xz6/" >> input
# RUN: lnt importreport --testsuite nts --order 123 --machine foo input output.json
# RUN: cat output.json
