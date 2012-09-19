/*
Flot plugin for highlighting regionst hat extend infinitely vertically
in a zoom independent manner.

The relevent arguments for this function are:

   1. range: Start and end revision number, i.e.,

         range: {start: REVISION1, end: REVISION2}

   2. color: The color to fill/stroke. Each number must be a string from 0-255, i.e.,

         color: ["0", "0", "255"]

      We use different alpha values for the regular/overview graph so to change that see below.

   3. alpha: What alpha should we use for the fill on the main graph. This should be a string again, i.e.,

         alpha: "0.2"

   4. strokealpha: What alpha should we use for the stroke on the overview graph. This should be a string
      again, i.e.,

         strokealpha: "1.0"

   5. stroke: Should we stroke the region on the overview graph? Should be a boolean, i.e.,

         stroke: true
*/

(function ($) {

    function init(plot) {
        plot.hooks.draw.push(function(plot, ctx) {
            var plot_offset = plot.getPlotOffset();
            var plot_height = plot.height();

            var range = plot.getOptions().highlight.range;
            var stroke = plot.getOptions().highlight.stroke;
            var color = plot.getOptions().highlight.color;
            var alpha = plot.getOptions().highlight.alpha;
            var strokealpha = plot.getOptions().highlight.strokealpha;

            var start = {x: range.start, y: 0};
            var end = {x: range.end, y: 0};

            var start_offset = plot.pointOffset(start);
            var end_offset = plot.pointOffset(end);

            var amin = plot.pointOffset({x: plot.getAxes().xaxis.min, y: plot.getAxes().yaxis.min});
            var amax = plot.pointOffset({x: plot.getAxes().xaxis.max, y: plot.getAxes().yaxis.max});
            var left_correction = Math.min(0, start_offset.left - amin.left);
            var right_correction = Math.min(0, amax.left - end_offset.left);

            var left = Math.max(start_offset.left, plot_offset.left);
            var top = plot_offset.top;
            var width = Math.max(end_offset.left - start_offset.left + left_correction + right_correction, 0);
            var height = amin.top - plot_offset.top;

            ctx.save();
            ctx.fillStyle = "rgba(" + color[0] + ", " + color[1] + ", " + color[2] + ", " + alpha + ")";
            ctx.fillRect(left, top, width, height);
            if (stroke) {
                ctx.lineWidth = 1;
                ctx.strokeStyle = "rgba(" + color[0] + ", " + color[1] + ", " + color[2] + ", " + strokealpha + ")";
                ctx.strokeRect(left, top, width, height);
            }
            ctx.restore();
        });
    }

    $.plot.plugins.push({
        init: init,
        options: {
            highlight: {
                range: {start: 0, end: 0},
                color: ["0", "0", "255"],
                alpha: "0.2",
                strokealpha: "1.0",
                stroke: false
            }
        },
        name: 'highlight',
        version: '1.0'
    });
})(jQuery);
