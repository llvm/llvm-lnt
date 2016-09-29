 $( function () {
        // Datatables need to be setup before floating headers!
        var dttable = $('table.datatable');
        $.each(dttable,
                function (k, e) {
                    $(e).DataTable({
                          "paging":   false,
                          "ordering": true,
                          "info":     false,
                          "filter": false,
                    });
                }
        );

        // For each floating header table, start the floatingTHead.
        var table = $('table.floating_header');
        $.each(table,
                function (k, e) {
                    $(e).floatThead({
                        position: 'absolute',
                        top: $('#header').height()-15,
                    });
                }
        );

        // Support for long and short dates.
        var shortDateFormat = 'MMM dd yyyy';
        var longDateFormat  = 'MMM dd yyyy HH:mm:ss';

        $(".shortDateFormat").each(function (idx, elem) {
            if ($(elem).is(":input")) {
                $(elem).val($.format.date($(elem).val(), shortDateFormat));
            } else {
                $(elem).text($.format.date($(elem).text(), shortDateFormat));
            }
        });
        $(".longDateFormat").each(function (idx, elem) {
            if ($(elem).is(":input")) {
                $(elem).val($.format.date($(elem).val(), longDateFormat));
            } else {
                $(elem).text($.format.date($(elem).text(), longDateFormat));
            }
        });
    });


